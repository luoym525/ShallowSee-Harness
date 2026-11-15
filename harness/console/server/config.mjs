import { access } from 'node:fs/promises';
import { badInput, badMethod, HttpError, isRecord, notFound, readJson, redactFields, sendJson } from './http.mjs';

const providerId = /^[a-z0-9-]{1,40}$/;
const roles = new Set(['intake', 'researcher', 'planner', 'reviewer', 'builder', 'tester', 'reflector', 'reporter', 'vision']);
const providerFields = new Set(['name', 'preset', 'kind', 'enabled', 'notes', 'website', 'baseUrl', 'apiKey', 'headers', 'models']);
const modelFields = new Set(['id', 'label', 'enabled', 'tier', 'capabilities', 'inputUsdPerMTok', 'outputUsdPerMTok']);
const capabilities = new Set(['reasoning', 'coding', 'vision', 'tools', 'json', 'long_context']);
const budgetFields = new Set(['maxUsdPerRun', 'maxMinutesPerRun', 'maxBuildIterations']);
const routingFields = new Set(['autonomy', 'overrides', 'preferVendorDiversity']);

function issue(path, message) {
  throw new HttpError(400, 'invalid_config', 'The configuration has invalid fields.', { issues: [{ path, message }] });
}

function checkFields(body, allowed, path) {
  if (Object.keys(body).some(key => !allowed.has(key))) issue(path, 'Remove unsupported fields.');
}

function validateModels(models) {
  if (!Array.isArray(models)) issue('models', 'Expected an array of configured models.');
  for (const model of models) {
    if (!isRecord(model)) issue('models', 'Expected model objects.');
    checkFields(model, modelFields, 'models');
    if (model.label !== undefined && typeof model.label !== 'string') issue('models.label', 'Expected a text label.');
    if (model.capabilities !== undefined && (!Array.isArray(model.capabilities)
      || model.capabilities.some(capability => !capabilities.has(capability)))) {
      issue('models.capabilities', 'Use supported model capabilities.');
    }
    for (const key of ['inputUsdPerMTok', 'outputUsdPerMTok']) {
      if (model[key] !== undefined && model[key] !== null && (!Number.isFinite(model[key]) || model[key] < 0)) {
        issue('models.' + key, 'Expected a non-negative price or null.');
      }
    }
  }
}

function validateProvider(body) {
  checkFields(body, providerFields, 'provider');
  for (const key of ['name', 'preset', 'kind', 'notes', 'website', 'baseUrl', 'apiKey']) {
    const value = body[key];
    if (value !== undefined && !(key === 'apiKey' && value === null) && typeof value !== 'string') {
      issue(key, 'Expected text.');
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') issue('enabled', 'Expected true or false.');
  if (body.headers !== undefined && body.headers !== null &&
    (!isRecord(body.headers) || Object.values(body.headers).some(value => typeof value !== 'string'))) {
    issue('headers', 'Expected header names with text values.');
  }
  if (body.models !== undefined) validateModels(body.models);
  return body;
}

export function budgetInput(body) {
  if (!isRecord(body)) issue('budget', 'Expected budget settings.');
  checkFields(body, budgetFields, 'budget');
  for (const [key, value] of Object.entries(body)) {
    if (!Number.isFinite(value) || value <= 0 || (key === 'maxBuildIterations' && !Number.isSafeInteger(value))) {
      issue('budget.' + key, 'Expected a positive budget limit.');
    }
  }
  return body;
}

export function autonomyInput(value) {
  if (value !== undefined && value !== 'full' && value !== 'confirm_plan') {
    issue('routing.autonomy', 'Choose full or confirm_plan.');
  }
  return value;
}

function routingInput(body) {
  checkFields(body, routingFields, 'routing');
  autonomyInput(body.autonomy);
  if (body.preferVendorDiversity !== undefined && typeof body.preferVendorDiversity !== 'boolean') {
    issue('routing.preferVendorDiversity', 'Expected true or false.');
  }
  if (body.overrides !== undefined && (!isRecord(body.overrides)
    || Object.entries(body.overrides).some(([role, ref]) => !roles.has(role) ||
      typeof ref !== 'string' || !/^[a-z0-9-]{1,40}\/.+$/.test(ref)))) {
    issue('routing.overrides', 'Choose a configured model reference for each pinned role.');
  }
  return body;
}

function providerRecord(config, id) {
  const provider = config.providers.find(item => item.id === id);
  if (!provider) throw notFound('No such provider.');
  return provider;
}

function providerErrors(error, providers, config) {
  if (['invalid_config', 'invalid_json'].includes(error.code)) {
    return new HttpError(400, 'invalid_config', 'The configuration has invalid fields.', {
      issues: redactFields(error.issues ?? [], text => providers.redact(text, config)),
    });
  }
  if (error.code === 'read_error') return new HttpError(500, 'config_read_failed', 'The local configuration could not be read.');
  if (error.code === 'write_error') return new HttpError(500, 'config_write_failed', 'The local configuration could not be saved.');
  return error;
}

export function createConfigApi({ getProviders, getRouter, configPath }) {
  let writes = Promise.resolve();
  const pathFor = providers => configPath ?? providers.DEFAULT_CONFIG_PATH;
  const respond = (res, status, payload, providers, config) =>
    sendJson(res, status, redactFields(payload, text => providers.redact(text, config)));

  async function load(providers) {
    try {
      return await providers.loadApiConfig({ path: pathFor(providers) });
    } catch (error) {
      throw providerErrors(error, providers);
    }
  }

  function write(providers, update) {
    const result = writes.then(async () => {
      const config = await load(providers);
      let next;
      try {
        next = update(config);
        await providers.saveApiConfig(next, { path: pathFor(providers) });
        return next;
      } catch (error) {
        throw providerErrors(error, providers, next ?? config);
      }
    });
    writes = result.catch(() => {});
    return result;
  }

  async function route(req, res, parts) {
    const [resource, id, action] = parts;
    const method = req.method;
    const providers = await getProviders();
    if (resource === 'health' && parts.length === 1) {
      if (method !== 'GET') throw badMethod();
      const path = pathFor(providers);
      const hasConfig = path ? await access(path).then(() => true, () => false) : false;
      return sendJson(res, 200, { ok: true, version: 'harness.console.v1', configPath: path ?? null, hasConfig });
    }
    if (resource === 'presets' && parts.length === 1) {
      if (method !== 'GET') throw badMethod();
      return sendJson(res, 200, { presets: providers.PROVIDER_PRESETS });
    }
    if (resource === 'config' && parts.length === 1) {
      if (method !== 'GET') throw badMethod();
      const config = await load(providers);
      const publicConfig = providers.redactApiConfig(config);
      return respond(res, 200, { config: publicConfig, validation: providers.validateApiConfig(config) }, providers, config);
    }
    if (resource === 'routing' && id === 'preview' && parts.length === 2) {
      if (method !== 'GET') throw badMethod();
      const config = await load(providers);
      const router = await getRouter();
      const roster = router.buildRoster(config);
      const rows = router.describeRouting(roster, {
        overrides: config.routing.overrides, preferVendorDiversity: config.routing.preferVendorDiversity,
      });
      return respond(res, 200, { rows }, providers, config);
    }
    if ((resource === 'routing' || resource === 'budget') && parts.length === 1) {
      if (method !== 'PUT') throw badMethod();
      const body = await readJson(req);
      const input = resource === 'budget' ? budgetInput(body) : routingInput(body);
      const config = await write(providers, old => ({ ...old, [resource]: { ...old[resource], ...input } }));
      return respond(res, 200, { [resource]: config[resource] }, providers, config);
    }
    if (resource !== 'providers' || parts.length > 3 || (id && !providerId.test(id))) {
      throw notFound('No such endpoint.');
    }
    if (!id) {
      if (method !== 'POST') throw badMethod();
      const input = validateProvider(await readJson(req));
      const config = await write(providers, old => providers.applyProviderInput(old, input));
      return respond(res, 201, { provider: providers.redactApiConfig(config).providers.at(-1) }, providers, config);
    }
    if (!action) {
      if (method !== 'PUT' && method !== 'DELETE') throw badMethod();
      const body = await readJson(req);
      const input = method === 'PUT' ? validateProvider(body) : null;
      const config = await write(providers, old => {
        providerRecord(old, id);
        return method === 'DELETE' ? providers.removeProvider(old, id) : providers.applyProviderInput(old, input, { id });
      });
      if (method === 'DELETE') return sendJson(res, 200, { ok: true });
      return respond(res, 200, { provider: providerRecord(providers.redactApiConfig(config), id) }, providers, config);
    }
    if (action !== 'test' && action !== 'fetch-models') throw notFound('No such endpoint.');
    if (method !== 'POST') throw badMethod();
    await readJson(req);
    const config = await load(providers);
    providerRecord(config, id);
    if (action === 'test') {
      try {
        const result = await providers.testProvider(config, id);
        return respond(res, 200, result, providers, config);
      } catch (error) {
        return respond(res, 200, { ok: false, latencyMs: null, detail: error.message || 'The provider test failed.' }, providers, config);
      }
    }
    try {
      const models = await providers.fetchRemoteModels(config, id);
      return respond(res, 200, { models }, providers, config);
    } catch (error) {
      const status = [400, 401, 403, 404, 429].includes(error.status) ? error.status : 502;
      const code = /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'provider_error';
      throw new HttpError(status, providers.redact(code, config), providers.redact(error.message || 'Could not fetch models.', config));
    }
  }

  return { route, load };
}

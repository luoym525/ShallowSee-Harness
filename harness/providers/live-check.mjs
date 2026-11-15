import { loadApiConfig, testProvider, createModelClient } from './index.mjs';
const config=await loadApiConfig();
if(!config.providers.length) console.log('SKIPPED: no providers configured');
else for(const p of config.providers){if(!p.enabled || (!p.apiKey && p.preset!=='ollama')) {console.log(`${p.id}: SKIPPED`);continue;} const result=await testProvider(config,p.id); if(!result.ok){console.log(`${p.id}: FAIL ${result.detail}`);continue;} const model=p.models?.find(m=>m.enabled); if(model && ['anthropic','openai_compatible'].includes(p.kind)){try{await createModelClient({config}).complete({model:`${p.id}/${model.id}`,messages:[{role:'user',content:'Hi'}],maxTokens:8});} catch {console.log(`${p.id}: FAIL completion`);continue;}} console.log(`${p.id}: PASS`);}

const rows = [
 ['anthropic','Anthropic (official)','anthropic','https://api.anthropic.com','https://console.anthropic.com',true,['claude-fable-5-2','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5']],
 ['openai','OpenAI','openai_compatible','https://api.openai.com/v1','https://platform.openai.com',true,[]],
 ['deepseek','DeepSeek','openai_compatible','https://api.deepseek.com','https://platform.deepseek.com',true,[]],
 ['gemini','Gemini','openai_compatible','https://generativelanguage.googleapis.com/v1beta/openai','https://aistudio.google.com',true,[]],
 ['openrouter','OpenRouter','openai_compatible','https://openrouter.ai/api/v1','https://openrouter.ai',true,[]],
 ['ollama','Ollama','openai_compatible','http://127.0.0.1:11434/v1','https://ollama.com',false,[]],
 ['custom','Custom','openai_compatible','','',true,[]],
 ['linkup','Linkup','linkup','https://api.linkup.so/v1','https://linkup.so',true,[]],
 ['github','GitHub','github','https://api.github.com','https://github.com',true,[]],
];
export const PROVIDER_PRESETS = rows.map(([id,name,kind,baseUrl,website,keyRequired,models]) => ({id,name,kind,baseUrl,website,keyRequired,keyHint:keyRequired ? `Create a key at ${website || 'your provider'}.` : 'No key required.',models:models.map(id=>({id,enabled:true}))}));

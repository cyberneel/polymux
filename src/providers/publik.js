// Publik provider: the Claude Code CLI on Publik's models. Everything is Claude's (launch, resume,
// fork, status, history, /rename) except the env that points the CLI at this deck's Publik route
// and the model tier picked in New Session. See ../publik.js for the route.
import { config } from '../config.js';
import { claude } from './claude.js';
import { connected, sessionToken } from '../publik.js';

// Picker tier → the Claude alias the CLI starts on (the route maps it back to the Publik tier,
// so the CLI's own /model switching keeps working).
const MODELS = { fast: 'haiku', balanced: 'sonnet', smart: 'opus' };

export const publik = {
  ...claude,
  kind: 'publik',
  label: 'Publik',
  models: [{ id: 'balanced', label: 'Balanced' }, { id: 'fast', label: 'Fast' }, { id: 'smart', label: 'Smart' }],
  // Offered only once a key is in ~/.publik/key (Friday's Connect Publik, or by hand).
  available: connected,
  launchArgs({ resume, fork, model }) {
    return `${claude.launchArgs({ resume, fork })} --model ${Object.hasOwn(MODELS, model) ? MODELS[model] : MODELS.balanced}`;
  },
  // The real key stays in the deck; the CLI gets a token that only this session's route accepts.
  launchEnv(name) {
    return `ANTHROPIC_BASE_URL='http://127.0.0.1:${config.port}/publik/${name}' ANTHROPIC_AUTH_TOKEN='${sessionToken(name)}' CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 `;
  },
};

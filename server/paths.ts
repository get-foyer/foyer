import { homedir } from 'os';
import { join } from 'path';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FOYER_CONFIG_DIR?.trim()) return env.FOYER_CONFIG_DIR.trim();
  if (env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME.trim(), 'foyer');
  return join(homedir(), '.config', 'foyer');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FOYER_CONFIG_PATH?.trim()) return env.FOYER_CONFIG_PATH.trim();
  return join(configDir(env), 'config.env');
}

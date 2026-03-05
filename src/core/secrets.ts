import type { SecretProvider } from "../types";

export class EnvSecretProvider implements SecretProvider {
  public get(name: string): string | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}

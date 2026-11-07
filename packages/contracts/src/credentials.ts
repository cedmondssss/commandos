import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'elevenlabs', 'daytona', 'anchor', 'surrealdb', 'arize']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const CredentialKeySchema = z.enum([
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'DAYTONA_API_KEY',
  'DAYTONA_API_URL',
  'DAYTONA_TARGET',
  'ANCHORBROWSER_API_KEY',
  'SPECTRON_URL',
  'SPECTRON_CONTEXT_ID',
  'SPECTRON_API_KEY',
  'ARIZE_SPACE_ID',
  'ARIZE_API_KEY',
]);
export type CredentialKey = z.infer<typeof CredentialKeySchema>;

export interface CredentialInfo {
  provider: ProviderId;
  label: string;
  secret: boolean;
  required: boolean;
}

export const CREDENTIAL_INFO: Readonly<Record<CredentialKey, CredentialInfo>> = {
  OPENAI_API_KEY: { provider: 'openai', label: 'OpenAI API key', secret: true, required: true },
  ELEVENLABS_API_KEY: { provider: 'elevenlabs', label: 'ElevenLabs API key', secret: true, required: true },
  DAYTONA_API_KEY: { provider: 'daytona', label: 'Daytona API key', secret: true, required: true },
  DAYTONA_API_URL: { provider: 'daytona', label: 'Daytona API URL (optional)', secret: false, required: false },
  DAYTONA_TARGET: { provider: 'daytona', label: 'Daytona target region (optional)', secret: false, required: false },
  ANCHORBROWSER_API_KEY: { provider: 'anchor', label: 'Anchor Browser API key', secret: true, required: true },
  SPECTRON_URL: { provider: 'surrealdb', label: 'Agent Memory context host URL', secret: false, required: true },
  SPECTRON_CONTEXT_ID: { provider: 'surrealdb', label: 'Agent Memory context id', secret: false, required: true },
  SPECTRON_API_KEY: { provider: 'surrealdb', label: 'Agent Memory API key', secret: true, required: true },
  ARIZE_SPACE_ID: { provider: 'arize', label: 'Arize space id', secret: false, required: true },
  ARIZE_API_KEY: { provider: 'arize', label: 'Arize API key', secret: true, required: true },
};

export const CredentialSourceSchema = z.enum(['keychain', 'env', 'missing']);
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

export const CredentialStatusSchema = z.object({
  key: CredentialKeySchema,
  provider: ProviderIdSchema,
  label: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
  source: CredentialSourceSchema,
  access: z.enum(['available', 'saved', 'unavailable']).optional(),
});
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

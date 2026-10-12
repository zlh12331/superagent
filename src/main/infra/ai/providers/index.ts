import { ProviderRegistry } from './registry';
import type {
  ProviderCreateContext,
  ProviderDefinition,
  ProviderFactory,
  ProviderInfo,
  ProviderKind,
  RegisteredProvider,
} from './types';

export { getProviderName, ProviderRegistry, toKeychainKey } from './registry';
export { PROVIDER_KINDS } from './types';
export type {
  ProviderCreateContext,
  ProviderDefinition,
  ProviderFactory,
  ProviderInfo,
  ProviderKind,
  RegisteredProvider,
};

export const providerRegistry = new ProviderRegistry();

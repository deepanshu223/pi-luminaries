import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type RootConfigurationHost } from './root-configuration.ts';
/** Production Pi extension boundary. Factory registration is intentionally resource-free. */
export default function luminariesExtension(pi: ExtensionAPI, configurationHost?: RootConfigurationHost): void;

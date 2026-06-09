export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: SchemaObject;
}

export interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  oneOf?: unknown[];
  anyOf?: unknown[];
  [key: string]: unknown;
}

export interface Provider {
  label: string;
  name: string;
  version: string;
  url?: string;
  title?: string;
  tabId?: number;
  providerId?: string;
  tools: ToolInfo[];
  prompts: unknown[];
  resources: unknown[];
  connectedAt: string;
}

export interface ProvidersResponse {
  service?: string;
  version: string;
  port: number;
  providers: Provider[];
}

export interface Selected {
  provider: string;
  key: string;
}

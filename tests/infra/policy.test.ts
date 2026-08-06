import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLE_NAMES } from '@autocosm/storage';

/**
 * Infrastructure policy assertions.
 *
 * These run against the ARM JSON produced by `az bicep build`, not against the Bicep source, so a
 * property that is set in a comment but not in the template fails here. `npm run infra:build`
 * compiles first and then runs this project.
 *
 * Every assertion below corresponds to a stated hard invariant. If one of them starts failing, the
 * correct response is to fix the template, never to relax the test.
 */

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const buildDir = path.join(root, 'infra', '.build');

/** `az` is a batch file on Windows, so it is invoked as a single shell command line. */
const AZ = process.platform === 'win32' ? 'az.cmd' : 'az';

/**
 * Compile a template on demand so this project never asserts on stale or missing output.
 *
 * `npm run infra:build` compiles first, in which case this is a cache hit. The fallback is what
 * lets a plain `vitest run` include the security gate instead of silently omitting it.
 */
function compile(name: string, target: string): void {
  mkdirSync(buildDir, { recursive: true });
  const source = path.join(root, 'infra', name);
  try {
    execSync(`${AZ} bicep build --file "${source}" --outfile "${target}"`, { stdio: 'pipe' });
  } catch (cause) {
    throw new Error(
      `Could not compile infra/${name}. The infrastructure policy assertions inspect the ARM JSON ` +
        `that az bicep build produces, so the Azure CLI with the Bicep extension is required to ` +
        `run them (no subscription, login or credential is needed).\n\n` +
        `  Install the CLI: https://learn.microsoft.com/cli/azure/install-azure-cli\n` +
        `  Install Bicep:   az bicep install\n\n` +
        `To run the code tests without it: npm run test:code`,
      { cause },
    );
  }
}

function template(name: string): ArmTemplate {
  const file = path.join(buildDir, name);
  if (!existsSync(file)) compile(name.replace(/\.json$/u, '.bicep'), file);
  return JSON.parse(readFileSync(file, 'utf8')) as ArmTemplate;
}

interface ArmResource {
  readonly type: string;
  readonly name?: string;
  readonly properties?: Record<string, unknown>;
  readonly identity?: { readonly type?: string; readonly userAssignedIdentities?: unknown };
  readonly sku?: { readonly name?: string };
  readonly resources?: readonly ArmResource[];
  readonly [key: string]: unknown;
}

interface ArmTemplate {
  readonly resources: readonly ArmResource[];
  readonly outputs?: Record<string, { readonly type: string; readonly value?: unknown }>;
  readonly parameters?: Record<string, { readonly type: string; readonly [k: string]: unknown }>;
}

/** Modules are nested deployments; their templates live inside `properties.template`. */
function flatten(t: ArmTemplate): ArmResource[] {
  const out: ArmResource[] = [];
  const walk = (resources: readonly ArmResource[]): void => {
    for (const resource of resources) {
      out.push(resource);
      if (resource.type === 'Microsoft.Resources/deployments') {
        const nested = (resource.properties as { template?: ArmTemplate } | undefined)?.template;
        if (nested?.resources) walk(nested.resources);
      }
      if (resource.resources) walk(resource.resources);
    }
  };
  walk(t.resources);
  return out;
}

const byType = (resources: readonly ArmResource[], type: string): ArmResource[] =>
  resources.filter((r) => r.type.toLowerCase() === type.toLowerCase());

const foundationTemplate = template('foundation.json');
const appTemplate = template('app.json');
const foundation = flatten(foundationTemplate);
const app = flatten(appTemplate);
const foundationJson = readFileSync(path.join(buildDir, 'foundation.json'), 'utf8');
const appJson = readFileSync(path.join(buildDir, 'app.json'), 'utf8');

/**
 * ARM keeps `variables()` and `parameters()` references unevaluated, so a template inspected as
 * data is full of expression strings. These helpers resolve the two forms the templates actually
 * use, which is what lets the assertions below compare real values rather than expression text.
 */
function nested(name: string): ArmTemplate {
  const module = byType(foundationTemplate.resources, 'Microsoft.Resources/deployments').find((d) =>
    String(d.name).includes(name),
  );
  const inner = (module?.properties as { template?: ArmTemplate } | undefined)?.template;
  if (inner === undefined) throw new Error(`module ${name} not found`);
  return inner;
}

function moduleParameters(name: string): Record<string, { value?: unknown }> {
  const module = byType(foundationTemplate.resources, 'Microsoft.Resources/deployments').find((d) =>
    String(d.name).includes(name),
  );
  return (
    (module?.properties as { parameters?: Record<string, { value?: unknown }> } | undefined)
      ?.parameters ?? {}
  );
}

/** Follows chained aliases: `tickWriteTables` is itself `[variables('allTables')]`. */
function deref(scope: ArmTemplate, value: unknown, depth = 0): unknown {
  if (typeof value !== 'string' || depth > 8) return value;
  const variable = /^\[variables\('([^']+)'\)\]$/u.exec(value);
  if (variable?.[1] !== undefined) {
    const resolved = (scope as unknown as { variables?: Record<string, unknown> }).variables?.[
      variable[1]
    ];
    return deref(scope, resolved, depth + 1);
  }
  const parameter = /^\[parameters\('([^']+)'\)\]$/u.exec(value);
  if (parameter?.[1] !== undefined) {
    return deref(scope, scope.parameters?.[parameter[1]]?.['defaultValue'], depth + 1);
  }
  return value;
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** Every role definition GUID an assignment could resolve to, following `variables()` and `if()`. */
function rolesOf(scope: ArmTemplate, assignment: ArmResource): string[] {
  const expression = String(assignment.properties?.['roleDefinitionId'] ?? '');
  const names = [...expression.matchAll(/variables\('([^']+)'\)/gu)].map((m) => m[1] ?? '');
  const sources =
    names.length > 0
      ? names.map((n) =>
          String(
            (scope as unknown as { variables?: Record<string, unknown> }).variables?.[n] ?? '',
          ),
        )
      : [expression];
  return sources.flatMap((text) => [...text.matchAll(GUID)].map((m) => m[0].toLowerCase()));
}

// Built-in role definition GUIDs referenced by the templates.
const ROLES = {
  storageTableDataReader: '76199698-9eea-4c19-bc75-cec21354c6b6',
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3',
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d',
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec',
  storageAccountContributor: '17d1049b-9a84-46fb-8f53-869881c3d3ab',
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
  cognitiveServicesOpenAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd',
} as const;

describe('storage is private and key-free', () => {
  const accounts = byType(foundation, 'Microsoft.Storage/storageAccounts');

  it('declares exactly one storage account', () => {
    expect(accounts).toHaveLength(1);
  });

  it('disables public network access', () => {
    expect(accounts[0]?.properties?.['publicNetworkAccess']).toBe('Disabled');
  });

  it('denies by default and bypasses nothing', () => {
    const acls = accounts[0]?.properties?.['networkAcls'] as Record<string, unknown>;
    expect(acls['defaultAction']).toBe('Deny');
    expect(acls['bypass']).toBe('None');
    expect(acls['ipRules']).toEqual([]);
    expect(acls['virtualNetworkRules']).toEqual([]);
  });

  it('disables shared key authorization', () => {
    expect(accounts[0]?.properties?.['allowSharedKeyAccess']).toBe(false);
  });

  it('disables anonymous blob access', () => {
    expect(accounts[0]?.properties?.['allowBlobPublicAccess']).toBe(false);
  });

  it('requires https and TLS 1.2 or newer', () => {
    expect(accounts[0]?.properties?.['supportsHttpsTrafficOnly']).toBe(true);
    const tls = String(accounts[0]?.properties?.['minimumTlsVersion']);
    expect(['TLS1_2', 'TLS1_3']).toContain(tls);
  });

  it('defaults to Entra authentication rather than key authentication', () => {
    expect(accounts[0]?.properties?.['defaultToOAuthAuthentication']).toBe(true);
  });
});

describe('private table endpoint and DNS', () => {
  const endpoints = byType(foundation, 'Microsoft.Network/privateEndpoints');
  const zones = byType(foundation, 'Microsoft.Network/privateDnsZones');
  const links = byType(foundation, 'Microsoft.Network/privateDnsZones/virtualNetworkLinks');
  const zoneGroups = byType(foundation, 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups');

  it('creates a private endpoint for the table service and nothing else', () => {
    expect(endpoints).toHaveLength(1);
    const connections = endpoints[0]?.properties?.['privateLinkServiceConnections'] as {
      properties: { groupIds: string[] };
    }[];
    expect(connections).toHaveLength(1);
    expect(connections[0]?.properties.groupIds).toEqual(['table']);
  });

  it('creates only the privatelink table DNS zone', () => {
    expect(zones).toHaveLength(1);
    expect(String(zones[0]?.name)).toContain('privatelink.table.');
  });

  it('links the DNS zone to the virtual network', () => {
    expect(links).toHaveLength(1);
    const vnet = (links[0]?.properties?.['virtualNetwork'] as { id: string } | undefined)?.id ?? '';
    expect(vnet).toContain('virtualNetworks');
  });

  it('binds the private endpoint to that zone', () => {
    expect(zoneGroups).toHaveLength(1);
    const configs = zoneGroups[0]?.properties?.['privateDnsZoneConfigs'] as unknown[];
    expect(configs).toHaveLength(1);
  });

  it('does not create blob or queue private endpoints', () => {
    expect(foundationJson).not.toContain('privatelink.blob.');
    expect(foundationJson).not.toContain('privatelink.queue.');
  });
});

describe('network shape', () => {
  const vnets = byType(foundation, 'Microsoft.Network/virtualNetworks');

  it('gives the Container Apps infrastructure subnet at least a /27', () => {
    const network = nested('network');
    const subnets = (vnets[0]?.properties?.['subnets'] as ArmResource[]).map((s) => ({
      prefix: String(
        deref(network, (s['properties'] as Record<string, unknown>)['addressPrefix']) ?? '',
      ),
      delegations: (s['properties'] as Record<string, unknown>)['delegations'],
    }));
    const infra = subnets.find((s) => s.delegations !== undefined && s.delegations !== null);
    expect(infra).toBeDefined();
    const mask = Number(infra?.prefix.split('/')[1]);
    expect(mask).toBeLessThanOrEqual(27);
  });

  it('delegates the infrastructure subnet to Microsoft.App/environments', () => {
    expect(foundationJson).toContain('Microsoft.App/environments');
  });

  it('uses a separate, undelegated subnet for private endpoints', () => {
    const subnets = vnets[0]?.properties?.['subnets'] as ArmResource[];
    expect(subnets).toHaveLength(2);
    const pe = subnets.find(
      (s) =>
        (s['properties'] as Record<string, unknown>)['privateEndpointNetworkPolicies'] !==
        undefined,
    );
    expect(pe).toBeDefined();
    expect((pe?.['properties'] as Record<string, unknown>)['delegations']).toBeUndefined();
  });

  it('adds no fixed-cost network appliances', () => {
    for (const type of [
      'Microsoft.Network/natGateways',
      'Microsoft.Network/azureFirewalls',
      'Microsoft.Network/virtualNetworkGateways',
      'Microsoft.Network/applicationGateways',
    ]) {
      expect(byType(foundation, type), type).toHaveLength(0);
    }
  });
});

describe('workload identities and least privilege', () => {
  const identityTemplate = nested('identity');
  const identities = byType(foundation, 'Microsoft.ManagedIdentity/userAssignedIdentities');
  const assignments = byType(foundation, 'Microsoft.Authorization/roleAssignments');

  it('creates one identity per runtime mode', () => {
    expect(identities).toHaveLength(4);
    const names = identities.map((i) => String(i.name));
    expect(names.some((n) => n.includes('web'))).toBe(true);
    expect(names.some((n) => n.includes('tick'))).toBe(true);
    expect(names.some((n) => n.includes('think'))).toBe(true);
    expect(names.some((n) => n.includes('admin'))).toBe(true);
  });

  it('grants only data-plane table roles, registry pull, and model inference', () => {
    const allowed = new Set<string>([
      ROLES.storageTableDataReader,
      ROLES.storageTableDataContributor,
      ROLES.acrPull,
      ROLES.cognitiveServicesOpenAiUser,
    ]);
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      const roles = rolesOf(identityTemplate, assignment);
      expect(roles.length, `no role resolved for ${String(assignment.name)}`).toBeGreaterThan(0);
      for (const role of roles) expect(allowed, String(assignment.name)).toContain(role);
    }
  });

  it('never grants a control-plane storage role', () => {
    expect(foundationJson).not.toContain(ROLES.storageAccountContributor);
    expect(foundationJson).not.toContain(ROLES.storageBlobDataContributor);
  });

  it('never grants registry push to a runtime identity', () => {
    expect(foundationJson).not.toContain(ROLES.acrPush);
  });

  it('scopes every table role to a single table, not the whole account', () => {
    const tableRoles = assignments.filter((a) =>
      rolesOf(identityTemplate, a).some((role) =>
        (
          [ROLES.storageTableDataReader, ROLES.storageTableDataContributor] as readonly string[]
        ).includes(role),
      ),
    );
    expect(tableRoles.length).toBeGreaterThan(0);
    for (const assignment of tableRoles) {
      const scope = String(assignment['scope'] ?? '');
      expect(scope, String(assignment.name)).toContain(
        'Microsoft.Storage/storageAccounts/tableServices/tables',
      );
    }
    // And nothing is scoped to the account itself, which would grant every table at once.
    for (const assignment of assignments) {
      expect(String(assignment['scope'] ?? '')).not.toMatch(
        /resourceId\('Microsoft\.Storage\/storageAccounts',/u,
      );
    }
  });

  it('grants Azure OpenAI inference to the thinker alone', () => {
    const inference = assignments.filter((a) =>
      rolesOf(identityTemplate, a).includes(ROLES.cognitiveServicesOpenAiUser),
    );
    expect(inference).toHaveLength(1);
    const principal = String(inference[0]?.properties?.['principalId'] ?? '');
    expect(principal).toContain('-think');
    expect(principal).not.toContain('-web');
    expect(principal).not.toContain('-tick');
    expect(principal).not.toContain('-admin');
  });
});

describe('the observer boundary is expressed in RBAC, not only in code', () => {
  const identityParams = moduleParameters('identity');
  const list = (name: string): string[] =>
    (deref(foundationTemplate, identityParams[name]?.value) as string[] | undefined) ?? [];

  it('passes the table lists the identity module expects', () => {
    expect(list('webReadTables').length).toBeGreaterThan(0);
    expect(list('webWriteTables').length).toBeGreaterThan(0);
    expect(list('tickWriteTables').length).toBeGreaterThan(0);
    expect(list('thinkWriteTables').length).toBeGreaterThan(0);
  });

  it('lets the public web app write only authoring and bookkeeping tables', () => {
    expect(new Set(list('webWriteTables'))).toEqual(
      new Set(['agents', 'lineages', 'goals', 'control']),
    );
  });

  it('never lets the public web app write world state', () => {
    const forbidden = [
      'worlds',
      'regions',
      'organisms',
      'structures',
      'materials',
      'resources',
      'events',
    ];
    for (const table of forbidden) {
      expect(list('webWriteTables'), table).not.toContain(table);
    }
  });

  it('gives the web app no access at all to the decision queue', () => {
    expect(list('webReadTables')).not.toContain('decisions');
    expect(list('webWriteTables')).not.toContain('decisions');
  });

  it('gives the thinker no access to world state, only to its queue and quota', () => {
    expect(new Set(list('thinkWriteTables'))).toEqual(new Set(['decisions', 'control']));
  });

  it('makes the tick job the only writer of authoritative world state', () => {
    expect(new Set(list('tickWriteTables'))).toEqual(new Set(Object.values(TABLE_NAMES)));
  });

  it('gives the admin inspector read access to every table and write access to control alone', () => {
    // Reader across the whole store...
    expect(new Set(list('adminReadTables'))).toEqual(new Set(Object.values(TABLE_NAMES)));
    // ...and contributor on exactly one table: `control`, which holds the runtime-settings row the
    // inspector's OpenAI-logging toggle writes. It can mutate nothing else.
    expect(new Set(list('adminWriteTables'))).toEqual(new Set(['control']));
  });

  it('declares every table the storage adapter uses', () => {
    const declared =
      (deref(foundationTemplate, moduleParameters('storage')['tableNames']?.value) as
        string[] | undefined) ?? [];
    expect(new Set(declared)).toEqual(new Set(Object.values(TABLE_NAMES)));
  });
});

describe('container platform', () => {
  const registries = byType(foundation, 'Microsoft.ContainerRegistry/registries');
  const environments = byType(foundation, 'Microsoft.App/managedEnvironments');

  it('uses a Basic registry with the admin user disabled', () => {
    expect(registries).toHaveLength(1);
    expect(registries[0]?.sku?.name).toBe('Basic');
    expect(registries[0]?.properties?.['adminUserEnabled']).toBe(false);
    expect(registries[0]?.properties?.['anonymousPullEnabled']).toBe(false);
  });

  it('uses a Consumption-only workload profile', () => {
    const profiles = environments[0]?.properties?.['workloadProfiles'] as {
      workloadProfileType: string;
    }[];
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.workloadProfileType).toBe('Consumption');
  });

  it('places the environment in the custom virtual network', () => {
    const vnet = environments[0]?.properties?.['vnetConfiguration'] as Record<string, unknown>;
    // The value is a template expression at this point; what matters is that the environment is
    // VNet-injected at all, and that the subnet it receives is the delegated one the network
    // module produced.
    expect(vnet['infrastructureSubnetId']).toBeDefined();
    expect(vnet['internal']).toBe(false);
    const platformModule = byType(foundation, 'Microsoft.Resources/deployments').find((d) =>
      String(d.name).includes('platform'),
    );
    expect(JSON.stringify(platformModule?.properties)).toContain('infrastructureSubnetId');
  });

  it('caps log ingestion and retention', () => {
    const workspaces = byType(foundation, 'Microsoft.OperationalInsights/workspaces');
    expect(workspaces[0]?.properties?.['workspaceCapping']).toBeDefined();
    // Both values are parameterised, so the guarantee lives in the parameter defaults and bounds.
    const platform = nested('platform');
    const quota = platform.parameters?.['logDailyQuotaGb'];
    const retention = platform.parameters?.['logRetentionDays'];
    expect(Number(quota?.['defaultValue'])).toBeGreaterThan(0);
    expect(Number(quota?.['defaultValue'])).toBeLessThanOrEqual(5);
    expect(Number(retention?.['defaultValue'])).toBeLessThanOrEqual(90);
    expect(Number(retention?.['maxValue'])).toBeLessThanOrEqual(730);
  });
});

describe('applications', () => {
  const apps = byType(app, 'Microsoft.App/containerApps');
  const jobs = byType(app, 'Microsoft.App/jobs');

  it('deploys the web app, the internal admin app, and two jobs', () => {
    expect(apps).toHaveLength(2);
    expect(jobs).toHaveLength(2);
    expect(apps.some((a) => String(a.name).includes('-web'))).toBe(true);
    expect(apps.some((a) => String(a.name).includes('-admin'))).toBe(true);
  });

  it('keeps external ingress off the admin app by default; only the web app is unconditionally public', () => {
    const ingressOf = (resource: ArmResource): Record<string, unknown> | undefined =>
      (resource.properties?.['configuration'] as Record<string, unknown>)['ingress'] as
        Record<string, unknown> | undefined;
    const web = apps.find((a) => String(a.name).includes('-web')) as ArmResource;
    const adminApp = apps.find((a) => String(a.name).includes('-admin')) as ArmResource;

    expect(ingressOf(web)?.['external']).toBe(true);
    expect(ingressOf(web)?.['allowInsecure']).toBe(false);

    // The inspector is internal unless explicitly opted in, and the default is off. Its external
    // flag is driven by that parameter and is never hard-coded to true.
    expect(appTemplate.parameters?.['adminExternalIngress']?.['defaultValue']).toBe(false);
    expect(ingressOf(adminApp)?.['external']).not.toBe(true);
    expect(ingressOf(adminApp)?.['allowInsecure']).toBe(false);

    // Exactly one component is unconditionally public, and it is the web app.
    const external = apps.filter((a) => ingressOf(a)?.['external'] === true);
    expect(external).toHaveLength(1);
    expect(String(external[0]?.name)).toContain('-web');

    for (const job of jobs) {
      const configuration = job.properties?.['configuration'] as Record<string, unknown>;
      expect(configuration['ingress'], String(job.name)).toBeUndefined();
    }
  });

  it('puts the admin app behind Entra sign-in whenever it is exposed externally', () => {
    const authConfigs = byType(app, 'Microsoft.App/containerApps/authConfigs');
    expect(authConfigs).toHaveLength(1);
    const json = JSON.stringify(authConfigs[0]);
    // Deployed only when the inspector is external — the same switch as the ingress.
    expect(json).toContain('adminExternalIngress');
    // An anonymous caller is redirected to Entra; the AAD provider is configured.
    expect(json).toContain('RedirectToLoginPage');
    expect(json).toContain('azureActiveDirectory');
  });

  it('scales the web and admin apps to zero', () => {
    for (const resource of apps) {
      const templateBlock = resource.properties?.['template'] as Record<string, unknown>;
      const scale = templateBlock['scale'] as Record<string, unknown>;
      expect(scale['minReplicas'], String(resource.name)).toBe(0);
    }
  });

  it('runs one execution of each job at a time, with no retry', () => {
    for (const job of jobs) {
      const configuration = job.properties?.['configuration'] as Record<string, unknown>;
      expect(configuration['triggerType'], String(job.name)).toBe('Schedule');
      expect(configuration['replicaRetryLimit'], String(job.name)).toBe(0);
      const schedule = configuration['scheduleTriggerConfig'] as Record<string, unknown>;
      expect(schedule['parallelism'], String(job.name)).toBe(1);
      expect(schedule['replicaCompletionCount'], String(job.name)).toBe(1);
    }
  });

  it('uses one user-assigned identity per workload and no system identity', () => {
    for (const resource of [...apps, ...jobs]) {
      expect(resource.identity?.type, String(resource.name)).toBe('UserAssigned');
      const assigned = Object.keys(
        (resource.identity?.userAssignedIdentities ?? {}) as Record<string, unknown>,
      );
      expect(assigned, String(resource.name)).toHaveLength(1);
    }
  });

  it('authenticates to the registry with a managed identity rather than a password', () => {
    for (const resource of [...apps, ...jobs]) {
      const configuration = resource.properties?.['configuration'] as Record<string, unknown>;
      const registries = configuration['registries'] as Record<string, unknown>[];
      expect(registries, String(resource.name)).toHaveLength(1);
      expect(registries[0]?.['identity'], String(resource.name)).toBeDefined();
      expect(registries[0]?.['passwordSecretRef'], String(resource.name)).toBeUndefined();
      expect(registries[0]?.['username'], String(resource.name)).toBeUndefined();
    }
  });

  it('sets AZURE_CLIENT_ID explicitly so credential selection is unambiguous', () => {
    for (const resource of [...apps, ...jobs]) {
      const containers = (resource.properties?.['template'] as Record<string, unknown>)[
        'containers'
      ] as { env?: { name: string }[] }[];
      const names = (containers[0]?.env ?? []).map((e) => e.name);
      expect(names, String(resource.name)).toContain('AZURE_CLIENT_ID');
      expect(names, String(resource.name)).toContain('AZURE_TABLE_ENDPOINT');
    }
  });

  it('forces the production storage driver and never a connection string', () => {
    for (const resource of [...apps, ...jobs]) {
      const containers = (resource.properties?.['template'] as Record<string, unknown>)[
        'containers'
      ] as { env?: { name: string; value?: string }[] }[];
      const env = containers[0]?.env ?? [];
      expect(
        env.find((e) => e.name === 'AUTOCOSM_STORAGE_DRIVER')?.value,
        String(resource.name),
      ).toBe('azureTables');
      expect(env.some((e) => /CONNECTION_STRING|ACCOUNT_KEY|SAS/iu.test(e.name))).toBe(false);
    }
  });

  it('passes each mode as an explicit argument to the shared image', () => {
    const modes = [...apps, ...jobs].map((resource) => {
      const containers = (resource.properties?.['template'] as Record<string, unknown>)[
        'containers'
      ] as { args?: string[]; image?: string }[];
      return { args: containers[0]?.args ?? [], image: containers[0]?.image };
    });
    expect(modes.map((m) => m.args.join())).toEqual(
      expect.arrayContaining(['web', 'tick', 'think', 'admin']),
    );
    // One image, four modes: every container reference is the same parameter.
    expect(new Set(modes.map((m) => m.image)).size).toBe(1);
  });

  it('bounds each job execution with a replica timeout', () => {
    for (const job of jobs) {
      const configuration = job.properties?.['configuration'] as Record<string, unknown>;
      expect(Number(configuration['replicaTimeout']), String(job.name)).toBeGreaterThan(0);
      expect(Number(configuration['replicaTimeout']), String(job.name)).toBeLessThanOrEqual(600);
    }
  });

  it('gives model access only to the think job', () => {
    const envOf = (resource: ArmResource): string[] => {
      const containers = (resource.properties?.['template'] as Record<string, unknown>)[
        'containers'
      ] as { env?: { name: string }[] }[];
      return (containers[0]?.env ?? []).map((e) => e.name);
    };
    expect(envOf(jobs.find((j) => String(j.name).includes('tick')) as ArmResource)).not.toContain(
      'AZURE_OPENAI_ENDPOINT',
    );
    for (const publicApp of apps) {
      expect(envOf(publicApp), String(publicApp.name)).not.toContain('AZURE_OPENAI_ENDPOINT');
    }
    expect(envOf(jobs.find((j) => String(j.name).includes('think')) as ArmResource)).toContain(
      'AZURE_OPENAI_ENDPOINT',
    );
  });

  it('never enables local seeding in the deployed configuration', () => {
    expect(appJson).not.toContain('AUTOCOSM_ALLOW_LOCAL_SEEDING');
  });
});

describe('no secret is accepted or emitted', () => {
  it('emits no output that could be a credential', () => {
    for (const [name, output] of Object.entries(foundationTemplate.outputs ?? {})) {
      expect(name).not.toMatch(/key|secret|password|connectionstring|sas/iu);
      expect(JSON.stringify(output)).not.toMatch(/listKeys|listAccountSas|listServiceSas/iu);
    }
    for (const [name, output] of Object.entries(appTemplate.outputs ?? {})) {
      expect(name).not.toMatch(/key|secret|password|connectionstring|sas/iu);
      expect(JSON.stringify(output)).not.toMatch(/listKeys|listAccountSas|listServiceSas/iu);
    }
  });

  it('never calls listKeys on the storage account', () => {
    // The Container Apps environment does read the Log Analytics shared key, which is a platform
    // wiring detail and not a storage credential, so the assertion is specific.
    expect(foundationJson).not.toMatch(/listKeys\([^)]*storageAccounts/iu);
    expect(appJson).not.toContain('listKeys');
  });

  it('accepts no secure parameter other than the prototype cookie-signing key', () => {
    const secure = (t: ArmTemplate): string[] =>
      Object.entries(t.parameters ?? {})
        .filter(([, spec]) => String(spec['type']).toLowerCase().startsWith('secure'))
        .map(([name]) => name);
    expect(secure(foundationTemplate)).toEqual([]);
    expect(secure(appTemplate)).toEqual(['creatorSigningKey']);
  });
});

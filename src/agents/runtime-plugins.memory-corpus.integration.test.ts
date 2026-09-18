// Verifies direct agent registry scopes retain root-owned memory corpus sidecars.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import {
  buildMemoryPromptSection,
  listMemoryCorpusSupplements,
  prepareMemoryPromptSection,
} from "../plugins/memory-state.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { getActivePluginRegistry, getPluginRegistrationContext } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  loadAgentRuntimePluginRegistryHandle,
  withAgentPluginRegistry,
} from "./runtime-plugins.js";

const MCP_CORPUS_PROBE_KEY = "__openclawMcpCorpusProbe";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[MCP_CORPUS_PROBE_KEY];
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

it("keeps root-owned memory sidecars in a direct agent registry", async () => {
  useNoBundledPlugins();
  const pluginId = "memory-corpus-sidecar";
  const configSchema = {
    type: "object",
    additionalProperties: false,
    properties: { source: { type: "string" } },
  };
  const plugin = writePlugin({
    id: pluginId,
    configSchema,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerTool({
      name: "corpus_probe",
      label: "Corpus probe",
      description: "Reports the request-scoped memory corpus owner.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const probe = globalThis[${JSON.stringify(MCP_CORPUS_PROBE_KEY)}];
        return {
          content: [{ type: "text", text: typeof probe === "function" ? probe() : "missing" }],
        };
      },
    });
    if (api.registrationMode === "full") {
      api.registerMemoryPromptSupplement(() => ["runtime wiki guidance"]);
      api.registerMemoryPromptPreparation(async () => ["runtime wiki digest"]);
      api.registerMemoryCorpusSupplement({
        search: async () => [],
        get: async () => null,
      });
    }
  },
};\n`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema, contracts: { tools: ["corpus_probe"] } }),
    "utf8",
  );
  const config = {
    plugins: {
      entries: { [pluginId]: { config: { source: "runtime" } } },
      load: { paths: [plugin.dir] },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  const rootConfig = applyPluginAutoEnable({ config, env: process.env }).config;
  expect(rootConfig.plugins?.entries?.[pluginId]?.enabled).toBe(true);
  const root = loadAndActivateRootPluginRegistry({
    cache: false,
    config: rootConfig,
    onlyPluginIds: [pluginId],
    workspaceDir,
  });

  expect(root.memoryCorpusSupplements.map((entry) => entry.pluginId)).toEqual([pluginId]);
  const rootSupplement =
    getActivePluginRegistry()?.memoryCorpusSupplements[0]?.supplement ??
    root.memoryCorpusSupplements[0]?.supplement;
  (globalThis as Record<string, unknown>)[MCP_CORPUS_PROBE_KEY] = () => {
    const registration = listMemoryCorpusSupplements().find((entry) => entry.pluginId === pluginId);
    return registration?.supplement === rootSupplement ? "root" : "wrong";
  };
  await withAgentPluginRegistry({
    config,
    workspaceDir,
    run: async () => {
      expect(listMemoryCorpusSupplements().map((entry) => entry.pluginId)).toEqual([pluginId]);
      const promptParams = { availableTools: new Set(["memory_search"]) };
      const prepared = await prepareMemoryPromptSection(promptParams);
      expect(buildMemoryPromptSection(promptParams, prepared)).toEqual([
        "runtime wiki guidance",
        "runtime wiki digest",
      ]);
    },
  });
  // Different workspace, same root source: adopts root identity.
  // The fixture already registers its memory sidecars only when api.registrationMode === 'full'.
  // Therefore the discovery load (via withAgentPluginRegistry) has a loaded same-source owner
  // but no local sidecar; adoption supplies the exact rootSupplement.
  const diffWorkspace = makePluginLoaderTempDir();
  await withAgentPluginRegistry({
    config, // original real config (same source)
    workspaceDir: diffWorkspace,
    run: async () => {
      const supplements = listMemoryCorpusSupplements();
      expect(supplements.map((entry) => entry.pluginId)).toEqual([pluginId]);
      expect(supplements[0]?.supplement).toBe(rootSupplement);
    },
  });
  // absent sidecar in scoped load adopts root (targetOwner undefined branch)
  // Keep plugin *enabled* in scoped config (for resolveEffectivePluginActivationState).
  // Exclude from scoped *load plan* via basePluginIds so target registry has no entry
  // (proves targetOwner-undefined path, not config disable).
  const absentConfig = {
    plugins: {
      entries: { [pluginId]: { enabled: true, config: { source: "runtime" } } },
      load: { paths: [plugin.dir] },
    },
  } satisfies OpenClawConfig;
  const absentWorkspace = makePluginLoaderTempDir();
  const absentRegistry = loadAgentRuntimePluginRegistryHandle({
    config: absentConfig,
    basePluginIds: [], // exclude sidecar from this generation's plan
    workspaceDir: absentWorkspace,
  });
  await withPluginRuntimeRegistryScope(absentRegistry, async () => {
    const supplements = listMemoryCorpusSupplements();
    expect(supplements.map((entry) => entry.pluginId)).toEqual([pluginId]);
    expect(supplements[0]?.supplement).toBe(rootSupplement);
  });
  // Root (source A) stays active: it bounds the scoped load to its plugin ids and is the donor
  // whose identity check (targetOwner.source !== runtimeOwner.source) refuses adoption.
  const shadowWorkspace = makePluginLoaderTempDir();
  const shadowPlugin = writePlugin({
    id: pluginId,
    configSchema,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerMemoryCorpusSupplement({
      search: async () => [{ corpus: "shadow" }],
      get: async () => null,
    });
  },
};\n`,
  });
  fs.writeFileSync(
    path.join(shadowPlugin.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema, contracts: { tools: ["corpus_probe"] } }),
    "utf8",
  );
  const shadowConfig = {
    plugins: {
      entries: { [pluginId]: { config: { source: "shadow" } } },
      load: { paths: [shadowPlugin.dir] },
    },
  } satisfies OpenClawConfig;
  await withAgentPluginRegistry({
    config: shadowConfig,
    workspaceDir: shadowWorkspace,
    run: async () => {
      const supplements = listMemoryCorpusSupplements();
      expect(supplements.map((entry) => entry.pluginId)).toEqual([pluginId]);
      expect(supplements[0]?.supplement).not.toBe(rootSupplement);
    },
  });
  await withAgentPluginRegistry({
    config: { plugins: { enabled: false } },
    workspaceDir,
    run: async () => {
      expect(listMemoryCorpusSupplements()).toEqual([]);
    },
  });

  // MCP loopback tool construction must capture the adopted registry used later
  // by wrapped plugin callbacks. Inspecting a separately loaded registry would
  // not prove the callback boundary that previously returned wiki:not-registered.
  const [{ resolveGatewayScopedTools }, { McpLoopbackToolCache }] = await Promise.all([
    import("../gateway/tool-resolution.js"),
    import("../gateway/mcp-http.runtime.js"),
  ]);
  const mcpDiffWs = makePluginLoaderTempDir();
  const mcpTools = resolveGatewayScopedTools({
    cfg: rootConfig,
    workspaceDir: mcpDiffWs,
    sessionKey: "mcp-loopback:diff-ws",
    surface: "loopback",
    inboundEventKind: "room_event",
  } as any);
  const directProbe = mcpTools.tools.find((tool) => tool.name === "corpus_probe");
  expect(directProbe).toBeDefined();
  await expect(directProbe?.execute("direct-probe", {})).resolves.toMatchObject({
    content: [{ type: "text", text: "root" }],
  });

  // Fresh and cached MCP catalogs must preserve the same callback-owned registry.
  const mcpCache = new McpLoopbackToolCache();
  const cacheCtx = {
    context: {
      sessionKey: "mcp-cache-test",
      toolsAllow: undefined,
      workspaceDir: mcpDiffWs,
    },
    cfg: rootConfig,
    grantToken: "g1",
  } as any;
  const c1 = await mcpCache.resolve(cacheCtx);
  const c2 = await mcpCache.resolve(cacheCtx);
  expect(c2).toBe(c1);
  for (const [toolCallId, cached] of [
    ["fresh-probe", c1],
    ["cached-probe", c2],
  ] as const) {
    const probe = cached.tools.find((tool) => tool.name === "corpus_probe");
    expect(probe).toBeDefined();
    await expect(probe?.execute(toolCallId, {})).resolves.toMatchObject({
      content: [{ type: "text", text: "root" }],
    });
  }

  const disabledMcp = resolveGatewayScopedTools({
    cfg: { plugins: { enabled: false } },
    disablePluginTools: true,
    workspaceDir: mcpDiffWs,
    sessionKey: "disabled-mcp",
    surface: "loopback",
  } as any);
  expect(disabledMcp.tools.some((tool) => tool.name === "corpus_probe")).toBe(false);
});

it("keeps a separately owned sidecar visible to nested Gateway memory_search", async () => {
  useNoBundledPlugins();
  const toolPluginId = "memory-core";
  const sidecarPluginId = "memory-corpus-sidecar-probe";
  const configSchema = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
  const toolPlugin = writePlugin({
    id: toolPluginId,
    configSchema,
    body: `module.exports = {
  id: ${JSON.stringify(toolPluginId)},
  register(api) {
    api.registerTool({
      name: "memory_search",
      label: "Memory search probe",
      description: "Reports whether the request registry carries the sidecar.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          corpus: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute() {
        const probe = globalThis[${JSON.stringify(MCP_CORPUS_PROBE_KEY)}];
        const outcome = typeof probe === "function" ? probe() : "not-registered";
        return {
          content: [{ type: "text", text: outcome }],
          details: {
            results: outcome === "ok" ? [{ path: "episodes/lazy-probe.md" }] : [],
            corpora: [{ corpus: "wiki", outcome }],
          },
        };
      },
    });
  },
};\n`,
  });
  fs.writeFileSync(
    path.join(toolPlugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: toolPluginId,
      configSchema,
      contracts: { tools: ["memory_search"] },
    }),
    "utf8",
  );
  const sidecarPlugin = writePlugin({
    id: sidecarPluginId,
    configSchema,
    body: `module.exports = {
  id: ${JSON.stringify(sidecarPluginId)},
  register(api) {
    if (api.registrationMode === "full") {
      api.registerMemoryCorpusSupplement({
        search: async () => [{
          corpus: "wiki",
          path: "episodes/lazy-probe.md",
          score: 1,
          snippet: "lazy sidecar result",
        }],
        get: async () => null,
      });
    }
  },
};\n`,
  });
  const config = {
    plugins: {
      entries: {
        [toolPluginId]: { enabled: true },
        [sidecarPluginId]: { enabled: true },
      },
      slots: { memory: toolPluginId },
      load: { paths: [toolPlugin.dir, sidecarPlugin.dir] },
    },
  } satisfies OpenClawConfig;
  const rootConfig = applyPluginAutoEnable({ config, env: process.env }).config;
  const root = loadAndActivateRootPluginRegistry({
    cache: false,
    config: rootConfig,
    onlyPluginIds: [toolPluginId, sidecarPluginId],
    workspaceDir: makePluginLoaderTempDir(),
  });
  expect(root.memoryCorpusSupplements.map((entry) => entry.pluginId)).toEqual([sidecarPluginId]);
  const workspaceDir = makePluginLoaderTempDir();
  (globalThis as Record<string, unknown>)[MCP_CORPUS_PROBE_KEY] = () =>
    listMemoryCorpusSupplements().some((entry) => entry.pluginId === sidecarPluginId)
      ? "ok"
      : "not-registered";
  const { invokeGatewayTool } = await import("../gateway/tools-invoke-shared.js");
  const requestRegistry = {
    ...root,
    plugins: root.plugins.filter((entry) => entry.id === toolPluginId),
    memoryCorpusSupplements: [],
    memoryPromptPreparations: [],
    memoryPromptSupplements: [],
  };
  expect(getActivePluginRegistry()).toBe(root);
  expect(getActivePluginRegistry()?.memoryCorpusSupplements.map((entry) => entry.pluginId)).toEqual(
    [sidecarPluginId],
  );
  let primaryRegistry: typeof root | undefined;
  const adopted = withPluginRuntimeRegistryScope(requestRegistry, () =>
    loadAgentRuntimePluginRegistryHandle(
      {
        config: rootConfig,
        workspaceDir,
        allowGatewaySubagentBinding: true,
      },
      (registry) => {
        primaryRegistry = registry;
      },
    ),
  );
  expect(primaryRegistry?.plugins.find((entry) => entry.id === sidecarPluginId)).toBeUndefined();
  expect(adopted.memoryCorpusSupplements.map((entry) => entry.pluginId)).toEqual([sidecarPluginId]);
  const invoked = await withPluginRuntimeRegistryScope(requestRegistry, () =>
    invokeGatewayTool({
      cfg: rootConfig,
      input: {
        name: "memory_search",
        sessionKey: "agent:main:test",
        agentId: "main",
        args: { query: "lazy sidecar", corpus: "wiki" },
      },
      senderIsOwner: true,
      operatorScopes: ["operator.admin"],
      conversationReadOrigin: "delegated",
      toolCallIdPrefix: "wiki-two-pass-probe",
    }),
  );
  expect(invoked).toMatchObject({
    ok: true,
    result: {
      details: {
        results: [expect.objectContaining({ path: "episodes/lazy-probe.md" })],
        corpora: [{ corpus: "wiki", outcome: "ok" }],
      },
    },
  });
});

it.each([
  { sidecarEnabled: true, shadow: false, retire: "source" },
  { sidecarEnabled: true, shadow: false, retire: "donor" },
  { sidecarEnabled: false, shadow: false, retire: "source" },
  { sidecarEnabled: true, shadow: true, retire: "source" },
])(
  "keeps sidecar policy and $retire lifetime in cold MCP tool fallback (enabled: $sidecarEnabled, shadow: $shadow)",
  async ({ sidecarEnabled, shadow, retire }) => {
    useNoBundledPlugins();
    const toolPluginId = "memory-core";
    const extraPluginId = "extra-tool-owner";
    const sidecarPluginId = "memory-fallback-sidecar";
    const configSchema = { type: "object", properties: {}, additionalProperties: false };
    const writeToolOwner = (id: string, toolName: string) => {
      const plugin = writePlugin({
        id,
        configSchema,
        body: `module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    globalThis[${JSON.stringify(MCP_CORPUS_PROBE_KEY)}]?.(true);
    api.registerTool({
      name: ${JSON.stringify(toolName)},
      label: "Memory fallback probe",
      description: "Reports the callback-owned sidecar and executable registry.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return {
          content: [{ type: "text", text: "probe" }],
          details: globalThis[${JSON.stringify(MCP_CORPUS_PROBE_KEY)}](),
        };
      },
    });
  },
};\n`,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({ id, configSchema, contracts: { tools: [toolName] } }),
        "utf8",
      );
      return plugin;
    };
    const toolPlugin = writeToolOwner(toolPluginId, "memory_search");
    const extraPlugin = writeToolOwner(extraPluginId, "extra_probe");
    const sidecarPlugin = writePlugin({
      id: sidecarPluginId,
      configSchema,
      body: `module.exports = {
  id: ${JSON.stringify(sidecarPluginId)},
  register(api) {
    if (api.registrationMode === "full") {
      api.registerMemoryCorpusSupplement({ search: async () => [], get: async () => null });
    }
  },
};\n`,
    });
    const workspaceDir = makePluginLoaderTempDir();
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: {
        allow: [toolPluginId, extraPluginId, sidecarPluginId],
        entries: {
          [toolPluginId]: { enabled: true },
          [extraPluginId]: { enabled: true },
          [sidecarPluginId]: { enabled: true },
        },
        slots: { memory: toolPluginId },
        load: { paths: [toolPlugin.dir, extraPlugin.dir, sidecarPlugin.dir] },
      },
    } satisfies OpenClawConfig;
    const root = loadAndActivateRootPluginRegistry({
      cache: false,
      config,
      // A different root workspace prevents the tool resolver borrowing the full root.
      workspaceDir: makePluginLoaderTempDir(),
    });
    const rootSupplement = root.memoryCorpusSupplements[0]?.supplement;
    expect(rootSupplement).toBeDefined();
    const loadedRegistries = new Set<typeof root>();
    (globalThis as Record<string, unknown>)[MCP_CORPUS_PROBE_KEY] = (registering?: boolean) => {
      if (registering) {
        const registry = getPluginRegistrationContext()?.registry;
        if (registry) {
          loadedRegistries.add(registry);
        }
        return undefined;
      }
      return {
        outcome:
          listMemoryCorpusSupplements().find((entry) => entry.pluginId === sidecarPluginId)
            ?.supplement === rootSupplement
            ? "root"
            : "not-registered",
        owners: getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.plugins.map(
          (entry) => entry.id,
        ),
      };
    };
    const requestRegistry = {
      ...root,
      plugins: root.plugins.filter((entry) => entry.id === toolPluginId),
      tools: root.tools.filter((entry) => entry.pluginId === toolPluginId),
      memoryCorpusSupplements: [],
      memoryPromptPreparations: [],
      memoryPromptSupplements: [],
    };
    const requestedSidecar = shadow
      ? writePlugin({
          id: sidecarPluginId,
          configSchema,
          body: `module.exports = { id: ${JSON.stringify(sidecarPluginId)}, register() {} };\n`,
        })
      : sidecarPlugin;
    const requestConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        load: { paths: [toolPlugin.dir, extraPlugin.dir, requestedSidecar.dir] },
        entries: {
          ...config.plugins.entries,
          [sidecarPluginId]: { enabled: sidecarEnabled },
        },
      },
    };
    const { McpLoopbackToolCache } = await import("../gateway/mcp-http.runtime.js");
    const cache = new McpLoopbackToolCache();
    const input = {
      context: {
        sessionKey: "agent:main:memory-fallback",
        toolsAllow: ["memory_search"],
        workspaceDir,
        modelHasVision: false,
      },
      cfg: requestConfig,
      grantToken: "memory-fallback-grant",
    };
    const fresh = await withPluginRuntimeRegistryScope(requestRegistry, () => cache.resolve(input));
    const cached = await withPluginRuntimeRegistryScope(requestRegistry, () =>
      cache.resolve(input),
    );
    expect(cached).toBe(fresh);
    for (const resolved of [fresh, cached]) {
      const tool = resolved.tools.find((entry) => entry.name === "memory_search");
      expect(tool).toBeDefined();
      // Execute after leaving the deficient scope: the factory must have captured
      // the cold fallback registry plus the exact permitted root supplement.
      await expect(tool?.execute("memory-fallback", {})).resolves.toMatchObject({
        details: {
          outcome: sidecarEnabled && !shadow ? "root" : "not-registered",
          owners: expect.arrayContaining([toolPluginId, extraPluginId]),
        },
      });
    }
    const sourceRegistry = [...loadedRegistries].find((registry) =>
      registry.plugins.some((entry) => entry.id === extraPluginId),
    );
    expect(sourceRegistry).toBeDefined();
    expect(sourceRegistry?.memoryCorpusSupplements).toEqual([]);
    markPluginRegistryRetired(retire === "donor" ? root : sourceRegistry);
    await expect(
      cached.tools.find((entry) => entry.name === "memory_search")?.execute("retired-fallback", {}),
    ).rejects.toThrow('Plugin "memory-core" tool runtime is no longer active.');
  },
);

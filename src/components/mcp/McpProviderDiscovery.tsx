import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import bigmodelLogo from "@/assets/mcp/zhipu-color.svg";
import composioLogo from "@/assets/mcp/composio-white.svg";
import githubLogo from "@/assets/mcp/github.svg";
import glamaLogo from "@/assets/mcp/glama.svg";
import higressLogo from "@/assets/mcp/higress-color.svg";
import mcpLogo from "@/assets/mcp/mcp.svg";
import mcpsoLogo from "@/assets/mcp/mcpso-color.svg";
import modelscopeLogo from "@/assets/mcp/modelscope-color.svg";
import smitheryLogo from "@/assets/mcp/smithery-color.svg";

interface McpProvider {
  id: string;
  name: string;
  description: string;
  url: string;
  logoSrc: string;
  logoTone?: "white" | "dark";
}

const MCP_PROVIDERS: McpProvider[] = [
  {
    id: "bigmodel",
    name: "BigModel MCP Market",
    description: "Curated MCP providers for fast setup",
    url: "https://bigmodel.cn/marketplace/index/mcp",
    logoSrc: bigmodelLogo,
  },
  {
    id: "modelscope",
    name: "modelscope.cn",
    description: "ModelScope community MCP servers",
    url: "https://modelscope.cn/mcp",
    logoSrc: modelscopeLogo,
  },
  {
    id: "higress",
    name: "mcp.higress.ai",
    description: "Higress MCP servers",
    url: "https://mcp.higress.ai/",
    logoSrc: higressLogo,
  },
  {
    id: "mcp-so",
    name: "mcp.so",
    description: "MCP server discovery platform",
    url: "https://mcp.so/",
    logoSrc: mcpsoLogo,
  },
  {
    id: "smithery",
    name: "smithery.ai",
    description: "Smithery MCP tools",
    url: "https://smithery.ai/",
    logoSrc: smitheryLogo,
  },
  {
    id: "glama",
    name: "glama.ai",
    description: "Glama MCP server directory",
    url: "https://glama.ai/mcp/servers",
    logoSrc: glamaLogo,
    logoTone: "white",
  },
  {
    id: "pulsemcp",
    name: "pulsemcp.com",
    description: "Pulse MCP servers",
    url: "https://www.pulsemcp.com/",
    logoSrc: mcpLogo,
    logoTone: "white",
  },
  {
    id: "composio",
    name: "mcp.composio.dev",
    description: "Composio MCP developer tools",
    url: "https://mcp.composio.dev/",
    logoSrc: composioLogo,
    logoTone: "dark",
  },
  {
    id: "official",
    name: "Model Context Protocol Servers",
    description: "Official MCP server collection",
    url: "https://github.com/modelcontextprotocol/servers",
    logoSrc: mcpLogo,
    logoTone: "white",
  },
  {
    id: "awesome",
    name: "Awesome MCP Servers",
    description: "Curated list of MCP servers",
    url: "https://github.com/punkpeye/awesome-mcp-servers",
    logoSrc: githubLogo,
    logoTone: "white",
  },
];

export function McpProviderDiscovery({
  onOpenUrl,
}: {
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useTranslation("tools");
  return (
    <section className="mt-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MCP_PROVIDERS.map((provider) => (
          <McpProviderCard
            key={provider.id}
            provider={provider}
            description={t(`discover.providers.${provider.id}`, { defaultValue: provider.description })}
            onOpen={() => onOpenUrl(provider.url)}
          />
        ))}
      </div>
    </section>
  );
}

function McpProviderCard({
  description,
  onOpen,
  provider,
}: {
  description: string;
  onOpen: () => void;
  provider: McpProvider;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-[116px] flex-col rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderLogo
            alt={`${provider.name} logo`}
            logoSrc={provider.logoSrc}
            tone={provider.logoTone}
          />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{provider.name}</h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {providerHost(provider.url)}
            </p>
          </div>
        </div>
        <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      </div>

      <p className="mt-3 line-clamp-2 min-h-[40px] text-sm leading-5 text-muted-foreground">
        {description}
      </p>
    </button>
  );
}

function ProviderLogo({
  alt,
  logoSrc,
  tone,
}: {
  alt: string;
  logoSrc: string;
  tone?: McpProvider["logoTone"];
}) {
  return (
    <div
      className={`flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border ${
        tone === "dark"
          ? "bg-zinc-950"
          : tone === "white"
            ? "bg-white"
            : "bg-background"
      }`}
    >
      <img src={logoSrc} alt={alt} className="size-6 object-contain" loading="lazy" />
    </div>
  );
}

function providerHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

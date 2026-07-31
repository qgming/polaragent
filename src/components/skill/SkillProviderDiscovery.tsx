import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Boxes,
  ExternalLink,
  GitFork,
  LibraryBig,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

interface SkillProvider {
  id: string;
  name: string;
  url: string;
  icon: LucideIcon;
}

const SKILL_PROVIDERS: SkillProvider[] = [
  {
    id: "skills-sh",
    name: "Skills.sh",
    url: "https://skills.sh/",
    icon: LibraryBig,
  },
  {
    id: "agent-skills",
    name: "Agent Skills",
    url: "https://agentskills.io/home",
    icon: BookOpen,
  },
  {
    id: "anthropic",
    name: "Anthropic Skills",
    url: "https://github.com/anthropics/skills",
    icon: Sparkles,
  },
  {
    id: "openai",
    name: "OpenAI Skills",
    url: "https://github.com/openai/skills",
    icon: Boxes,
  },
  {
    id: "awesome",
    name: "Awesome Agent Skills",
    url: "https://github.com/VoltAgent/awesome-agent-skills",
    icon: GitFork,
  },
  {
    id: "github-topic",
    name: "GitHub Agent Skills",
    url: "https://github.com/topics/agent-skills",
    icon: GitFork,
  },
];

export function SkillProviderDiscovery({
  onOpenUrl,
}: {
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useTranslation("skills");

  return (
    <section className="mt-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SKILL_PROVIDERS.map((provider) => (
          <SkillProviderCard
            key={provider.id}
            provider={provider}
            description={t(`discover.providers.${provider.id}`)}
            onOpen={() => onOpenUrl(provider.url)}
          />
        ))}
      </div>
    </section>
  );
}

function SkillProviderCard({
  description,
  onOpen,
  provider,
}: {
  description: string;
  onOpen: () => void;
  provider: SkillProvider;
}) {
  const Icon = provider.icon;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-[116px] flex-col rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
            <Icon className="size-5" />
          </div>
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

function providerHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

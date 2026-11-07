import type { ToolDescriptor } from '@commandos/contracts';
import { aiTools } from './ai';
import { appTools } from './apps';
import { browserPageTools } from './browserpage';
import { browserAttachmentTools } from './browser-attachment';
import { cameraTools } from './camera';
import { desktopTools } from './wallpaper';
import { dataTools } from './data';
import { docTools } from './docs';
import { fsTools } from './fs';
import { gmailTools } from './gmail';
import { repoLocate } from './github';
import { osaTools } from './osa';
import { reportTools } from './report';
import { sandboxTools } from './sandbox';
import { screenshotTools } from './screenshots';
import { terminalTools } from './terminal';
import { uiTools } from './ui';
import { visionTools } from './vision';
import { webTools } from './web';
import { type AnyTool, describeTool, ToolError } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(...tools: AnyTool[]): this {
    for (const t of tools) {
      if (this.tools.has(t.id)) throw new Error(`duplicate tool id ${t.id}`);
      this.tools.set(t.id, t);
    }
    return this;
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  get(id: string): AnyTool | undefined {
    return this.tools.get(id);
  }

  require(id: string): AnyTool {
    const t = this.tools.get(id);
    if (!t) throw new ToolError('unknown_tool', `unknown tool "${id}"`);
    return t;
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map(describeTool);
  }
}

export function createDefaultRegistry(extra: AnyTool[] = []): ToolRegistry {
  return new ToolRegistry().register(
    ...fsTools,
    ...docTools,
    ...dataTools,
    ...screenshotTools,
    ...aiTools,
    ...reportTools,
    ...appTools,
    ...terminalTools,
    ...osaTools,
    ...uiTools,
    ...visionTools,
    ...sandboxTools,
    repoLocate,
    ...webTools,
    ...gmailTools,
    ...cameraTools,
    ...desktopTools,
    ...browserPageTools,
    ...browserAttachmentTools,
    ...extra,
  );
}

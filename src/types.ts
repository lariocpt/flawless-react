export type PropPrimitive = string | number | boolean | null;
export type PropValue = PropPrimitive | PropValue[] | { [k: string]: PropValue };
export type PropsShape = Record<string, PropValue>;

export interface ComponentInfo {
  componentName: string;
  filePath: string;
  importSpecifier: string;
  propsShape: PropsShape;
  variants: PropsShape[];
  hooks: string[];
  unresolvedProps: string[];
}

export interface ComponentTree {
  entry: ComponentInfo;
  children: ComponentTree[];
}

export interface AnalyseOptions {
  entry: string;
  depth: number;
  includeChildren: boolean;
}

export interface MockRoute {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface ScaffoldOptions {
  outDir: string;
  variants: number;
  force: boolean;
  report: boolean;
  provider: string | undefined;
  apiSpec: string | undefined;
}

export interface CliArgs {
  entry: string;
  out: string | undefined;
  depth: number;
  variants: number;
  includeChildren: boolean;
  force: boolean;
  report: boolean;
  propsOverride: PropsShape | undefined;
  provider: string | undefined;
  apiSpec: string | undefined;
}

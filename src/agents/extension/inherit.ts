import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// Workers inherit the parent's resources: provider extensions carry
// credentials, and skills/extensions define what the parent can do. Discovery
// (~/.pi/agent, project .pi, settings packages) is inherited by not disabling
// it; explicit command-line resources are forwarded here.
const EXTENSION = new Set(["-e", "--extension"]);
const SKILL = new Set(["--skill"]);
const NO_EXTENSIONS = new Set(["-ne", "--no-extensions"]);
const NO_SKILLS = new Set(["-ns", "--no-skills"]);

/** Package sources such as builtin:mcp or npm:foo are not filesystem paths. */
const isSource = (value: string) => /^[a-z][a-z0-9+.-]*:/i.test(value);

const canonical = (value: string, cwd: string) => {
  if (isSource(value)) return value;
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export interface ParentResources {
  extensions: string[];
  skills: string[];
  noExtensions: boolean;
  noSkills: boolean;
}

/** Parse the resource flags the parent Pi was launched with. */
export function parentResources(argv: string[], cwd: string): ParentResources {
  const resources: ParentResources = {
    extensions: [],
    skills: [],
    noExtensions: false,
    noSkills: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--")
      ? [
          arg.split("=", 1)[0],
          arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined,
        ]
      : [arg, undefined];
    if (NO_EXTENSIONS.has(arg)) resources.noExtensions = true;
    else if (NO_SKILLS.has(arg)) resources.noSkills = true;
    else if (EXTENSION.has(flag) || SKILL.has(flag)) {
      const value = inline ?? argv[++index];
      if (value === undefined) break;
      (EXTENSION.has(flag) ? resources.extensions : resources.skills).push(
        canonical(value, cwd),
      );
    }
  }
  return resources;
}

const unique = (values: string[]) => [...new Set(values)];

/**
 * Resource arguments for a worker: the parent's discovery settings and
 * explicit resources, the private child extension, and role additions.
 */
export function childResourceArgs(
  parent: ParentResources,
  child: { extension: string; extensions: string[]; skills: string[] },
  cwd: string,
): string[] {
  const extensions = unique(
    [child.extension, ...parent.extensions, ...child.extensions].map((p) =>
      canonical(p, cwd),
    ),
  );
  const skills = unique(
    [...parent.skills, ...child.skills].map((p) => canonical(p, cwd)),
  );
  return [
    ...(parent.noExtensions ? ["--no-extensions"] : []),
    ...extensions.flatMap((path) => ["--extension", path]),
    ...(parent.noSkills ? ["--no-skills"] : []),
    ...skills.flatMap((path) => ["--skill", path]),
  ];
}

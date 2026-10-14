import { Args, Command, Flags } from "@oclif/core";
import { FileConfigStore } from "../infrastructure/config-store.js";
import { tagMap, DEFAULTS } from "../domain/config.js";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** oclif's generic zsh generator currently emits _files for dynamic value callbacks.
 * Keep metadata-driven flags, but resolve activity values from configuration on each Tab. */
export class ZshCompletion extends Command {
  static description = "输出 zsh/bash 补全脚本，活动标签随配置实时更新";
  static args = {
    shell: Args.string({ required: true, options: ["zsh", "bash"] }),
  };
  async run(): Promise<void> {
    const { args } = await this.parse(ZshCompletion);
    const commands = this.config.commands.filter(
      (c) =>
        !c.hidden &&
        c.id.includes(":") &&
        !c.id.startsWith("autocomplete:") &&
        !c.id.startsWith("completion:"),
    );
    const topics = [...new Set(commands.map((c) => c.id.split(":")[0]!))];
    if (args.shell === "bash") {
      const branches = commands
        .map((c) => {
          const flags = Object.entries(c.flags).filter(([, f]) => !f.hidden);
          const values = flags
            .filter(([, f]) => f.type === "option" && f.options)
            .map(
              ([name, f]) =>
                `${quote("--" + name)}${f.char ? "|" + quote("-" + f.char) : ""}) candidates=(${(f.type === "option" ? (f.options ?? []) : []).map(quote).join(" ")});;`,
            )
            .join("\n");
          return `${quote(c.id)})
  if [[ "$cur" == -* ]]; then candidates=(${flags.flatMap(([name, f]) => [quote("--" + name), ...(f.char ? [quote("-" + f.char)] : [])]).join(" ")} --help); fi
  case "$prev" in
  ${c.id === "kml:set-tag" ? `--tag) while IFS= read -r value; do candidates+=("$value"); done < <(${quote(process.execPath)} ${quote(process.argv[1]!)} completion tags "\${config_args[@]}" 2>/dev/null);;` : ""}
  ${values}
  esac
  ;;`;
        })
        .join("\n");
      const topicsCase = topics
        .map(
          (topic) =>
            `${quote(topic)}) candidates=(${commands
              .filter((c) => c.id.startsWith(topic + ":"))
              .map((c) => quote(c.id.split(":")[1]!))
              .join(" ")});;`,
        )
        .join("\n");
      this.log(`# Generated from current oclif metadata.
_tracktool_live() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" i=1 j value topic subcommand
  local -a candidates=() config_args=()
  COMPREPLY=()
  for ((j=1;j<COMP_CWORD;j++)); do
    case "\${COMP_WORDS[j]}" in
      --config) config_args=(--config "\${COMP_WORDS[j+1]}");;
      --config=*) config_args=("\${COMP_WORDS[j]}");;
    esac
  done
  while ((i<COMP_CWORD)); do
    case "\${COMP_WORDS[i]}" in
      --config) ((i+=2));;
      --config=*|--dry-run|--verbose|--quiet|-v|-vv|-q) ((i++));;
      *) break;;
    esac
  done
  topic="\${COMP_WORDS[i]}"; subcommand="\${COMP_WORDS[i+1]}"
  if ((COMP_CWORD==i)); then candidates=(${topics.map(quote).join(" ")} autocomplete completion)
  elif ((COMP_CWORD==i+1)); then
    case "$topic" in
${topicsCase}
    esac
  else
    case "$topic:$subcommand" in
${branches}
    esac
  fi
  for value in "\${candidates[@]}"; do [[ "$value" == "$cur"* ]] && COMPREPLY+=("$value"); done
  if ((\${#candidates[@]}==0)); then
    while IFS= read -r value; do COMPREPLY+=("$value"); done < <(compgen -f -- "$cur")
    type compopt >/dev/null 2>&1 && compopt -o filenames
  fi
  return 0
}
complete -o default -o bashdefault -F _tracktool_live tracktool`);
      return;
    }
    const topicsCase = topics
      .map(
        (topic) =>
          `${quote(topic)}) compadd -- ${commands
            .filter((c) => c.id.startsWith(topic + ":"))
            .map((c) => quote(c.id.split(":")[1]!))
            .join(" ")} ;;`,
      )
      .join("\n");
    const flagsCase = commands
      .map((c) => {
        const flags = Object.entries(c.flags)
          .filter(([, f]) => !f.hidden)
          .flatMap(([name, f]) => {
            const suffix =
              f.type === "option"
                ? name === "tag" && c.id === "kml:set-tag"
                  ? ":activity:_tracktool_live_tags"
                  : f.options
                    ? `:value:(${f.options.join(" ")})`
                    : ":file:_files"
                : "";
            const description = (f.description ?? name).replaceAll(
              /[\[\]\n]/g,
              " ",
            );
            return [
              quote(`--${name}[${description}]${suffix}`),
              ...(f.char ? [quote(`-${f.char}[${description}]${suffix}`)] : []),
            ];
          });
        return `${quote(c.id)}) _arguments -S ${[...flags, quote("--help[显示帮助]"), ...(c.id === "config:set" ? [quote("3:key:(" + Object.keys(DEFAULTS).join(" ") + ")"), quote("4:value:")] : [quote("*:file:_files")])].join(" ")} ;;`;
      })
      .join("\n");
    this.log(`# Generated from the current oclif command metadata.
_tracktool_live_tags() {
  local -a values config_args
  local j
  for ((j=2; j<=$#words; j++)); do
    if [[ $words[j] == --config ]]; then config_args=(--config "$words[j+1]"); fi
    if [[ $words[j] == --config=* ]]; then config_args=("$words[j]"); fi
  done
  values=("\${(@f)$(${quote(process.execPath)} ${quote(process.argv[1]!)} completion tags "\${config_args[@]}" 2>/dev/null)}")
  compadd -a values
}
_tracktool_live() {
  local -a original_words=("\${words[@]}")
  local i=2 topic subcommand
  while ((i<CURRENT)); do
    case "$words[i]" in
      --config) ((i+=2));;
      --config=*|--dry-run|--verbose|--quiet|-v|-vv|-q) ((i++));;
      *) break;;
    esac
  done
  if ((CURRENT==i)); then compadd -- ${topics.map(quote).join(" ")} autocomplete completion; return; fi
  topic=$words[i]
  if ((CURRENT==i+1)); then
    case "$topic" in
${topicsCase}
    esac
    return
  fi
  subcommand=$words[i+1]
  case "$topic:$subcommand" in
${flagsCase}
    *) _files ;;
  esac
}
compdef _tracktool_live tracktool`);
  }
}
export class CompletionTags extends Command {
  static hidden = true;
  static flags = { config: Flags.string() };
  async run(): Promise<void> {
    const { flags } = await this.parse(CompletionTags);
    const config = await new FileConfigStore({ path: flags.config }).load();
    for (const tag of tagMap(config).keys()) this.log(tag);
  }
}

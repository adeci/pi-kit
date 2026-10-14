self: platform:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  names = [
    "status"
    "usage"
    "ask"
    "agents"
    "jobs"
    "events"
    "todos"
    "handoff"
    "goal"
    "director"
  ];
  cfg = config.pi-kit;
  component =
    name:
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      original = (import (../src + "/${name}/modules/${platform}.nix") self) { inherit config lib pkgs; };
    in
    {
      imports = original.imports or [ ];
      options = (original.options or { }) // {
        pi-kit.${name}.enable = lib.mkEnableOption "pi-kit ${name}";
      };
      config = lib.mkIf config.pi-kit.${name}.enable (
        original.config or (builtins.removeAttrs original [
          "imports"
          "options"
        ])
      );
    };
  # Only remove our own generated symlinks. Never delete user files/directories
  # or links to unrelated packages when a component is disabled.
  links =
    name:
    [
      {
        path = ".agents/extensions/kit-${name}";
        target = "share/pi-kit/${name}/extension";
      }
      {
        path = ".pi/agent/extensions/kit-${name}";
        target = "share/pi-kit/${name}/extension";
      }
    ]
    ++
      lib.optionals
        (builtins.elem name [
          "agents"
          "jobs"
        ])
        [
          {
            path = ".agents/skills/kit-${name}";
            target = "share/skills/kit-${name}";
          }
          {
            path = ".pi/agent/skills/kit-${name}";
            target = "share/skills/kit-${name}";
          }
        ];
  disabledLinks = lib.concatMap links (builtins.filter (name: !cfg.${name}.enable) names);
  cleanup = pkgs.writeShellScript "pi-kit-disabled-links" (
    lib.concatMapStringsSep "\n" (link: ''
      if [ -L "$HOME/${link.path}" ]; then
        case "$(${pkgs.coreutils}/bin/readlink "$HOME/${link.path}")" in
          /nix/store/*/${link.target}) ${pkgs.coreutils}/bin/rm -- "$HOME/${link.path}" ;;
        esac
      fi
    '') disabledLinks
  );
in
{
  imports = map component names;
  options.pi-kit.jobs.daemon.enable = lib.mkEnableOption "the isolated Pueue daemon for pi-kit jobs";
  config = lib.mkMerge [
    {
      services.pi-jobs.enable = lib.mkDefault (cfg.jobs.enable && cfg.jobs.daemon.enable);
      assertions = [
        {
          assertion = !cfg.director.enable || cfg.agents.enable;
          message = "pi-kit.director.enable requires pi-kit.agents.enable";
        }
        {
          assertion = !cfg.jobs.daemon.enable || cfg.jobs.enable;
          message = "pi-kit.jobs.daemon.enable requires pi-kit.jobs.enable";
        }
      ];
    }
    (lib.optionalAttrs (platform == "nixos") {
      systemd.user.services.pi-kit-links = {
        description = "Maintain pi-kit managed links";
        wantedBy = [ "default.target" ];
        script = "${cleanup}";
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;

        };
      };
    })
    (lib.optionalAttrs (platform == "darwin") {
      system.activationScripts.postActivation.text = ''
        HOME=${lib.escapeShellArg config.users.users.${config.system.primaryUser}.home} ${cleanup}
      '';
    })
  ];
}

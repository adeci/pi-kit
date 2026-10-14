self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-agents;
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
in
{
  environment.systemPackages = [ package ];
  environment.variables.XDG_RUNTIME_DIR = lib.mkDefault "/tmp/pi-kit-${user}";
  system.activationScripts.postActivation.text = # bash
    ''
      install -d -m 700 -o ${user} -g staff ${config.environment.variables.XDG_RUNTIME_DIR}
      install -d -o ${user} -g staff ${home}/.agents/skills ${home}/.agents/extensions
      ln -sfn ${package}/share/pi-kit/agents/extension ${home}/.agents/extensions/kit-agents
      install -d -o ${user} -g staff ${home}/.pi/agent/extensions
      ln -sfn ${package}/share/pi-kit/agents/extension ${home}/.pi/agent/extensions/kit-agents
      ln -sfn ${package}/share/skills/kit-agents ${home}/.agents/skills/kit-agents
    '';
}

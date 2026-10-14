self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-events;
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
in
{
  environment.systemPackages = [ package ];
  environment.variables.XDG_RUNTIME_DIR = lib.mkDefault "/tmp/pi-kit-${user}";
  system.activationScripts.postActivation.text = # bash
    ''
      install -d -m 700 -o ${user} -g staff ${config.environment.variables.XDG_RUNTIME_DIR}
      install -d -o ${user} -g staff ${home}/.agents/extensions
      ln -sfn ${package}/share/pi-kit/events/extension ${home}/.agents/extensions/kit-events
      install -d -o ${user} -g staff ${home}/.pi/agent/extensions
      ln -sfn ${package}/share/pi-kit/events/extension ${home}/.pi/agent/extensions/kit-events
    '';
}

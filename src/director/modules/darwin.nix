self:
{ config, pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-director;
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
in
{
  environment.systemPackages = [ package ];
  system.activationScripts.postActivation.text = # bash
    ''
      install -d -o ${user} -g staff ${home}/.agents/extensions ${home}/.pi/agent/extensions
      ln -sfn ${package}/share/pi-kit/director/extension ${home}/.agents/extensions/kit-director
      ln -sfn ${package}/share/pi-kit/director/extension ${home}/.pi/agent/extensions/kit-director
    '';
}

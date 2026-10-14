self:
{ config, pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-todos;
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
in
{
  environment.systemPackages = [ package ];
  system.activationScripts.postActivation.text = # bash
    ''
      install -d -o ${user} -g staff ${home}/.agents/extensions ${home}/.pi/agent/extensions
      ln -sfn ${package}/share/pi-kit/todos/extension ${home}/.agents/extensions/kit-todos
      ln -sfn ${package}/share/pi-kit/todos/extension ${home}/.pi/agent/extensions/kit-todos
    '';
}

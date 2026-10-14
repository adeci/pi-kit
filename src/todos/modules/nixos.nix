self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-todos;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-todos - - - - ${package}/share/pi-kit/todos/extension"
    "L+ %h/.pi/agent/extensions/kit-todos - - - - ${package}/share/pi-kit/todos/extension"
  ];
}

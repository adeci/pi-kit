self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-goal;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-goal - - - - ${package}/share/pi-kit/goal/extension"
    "L+ %h/.pi/agent/extensions/kit-goal - - - - ${package}/share/pi-kit/goal/extension"
  ];
}

self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-handoff;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-handoff - - - - ${package}/share/pi-kit/handoff/extension"
    "L+ %h/.pi/agent/extensions/kit-handoff - - - - ${package}/share/pi-kit/handoff/extension"
  ];
}

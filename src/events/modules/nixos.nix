self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-events;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-events - - - - ${package}/share/pi-kit/events/extension"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.pi/agent/extensions/kit-events - - - - ${package}/share/pi-kit/events/extension"
  ];
}

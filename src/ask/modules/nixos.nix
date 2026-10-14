self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-ask;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.agents/extensions/kit-ask - - - - ${package}/share/pi-kit/ask/extension"
    "L+ %h/.pi/agent/extensions/kit-ask - - - - ${package}/share/pi-kit/ask/extension"
  ];
}

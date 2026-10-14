self:
{ pkgs, ... }:
let
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-kit-agents;
in
{
  environment.systemPackages = [ package ];
  systemd.user.tmpfiles.rules = [
    "d %h/.agents/extensions - - - - -"
    "d %h/.agents/skills - - - - -"
    "L+ %h/.agents/extensions/kit-agents - - - - ${package}/share/pi-kit/agents/extension"
    "d %h/.pi/agent/extensions - - - - -"
    "L+ %h/.pi/agent/extensions/kit-agents - - - - ${package}/share/pi-kit/agents/extension"
    "L+ %h/.agents/skills/kit-agents - - - - ${package}/share/skills/kit-agents"
  ];
}

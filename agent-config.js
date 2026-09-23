// Identité de l'agent terrain, séparée de map-config.js (config carte, partagée
// avec settings.html) — propre à agent.html, un seul champ : le nom saisi une fois.
const AGENT_NAME_KEY = 'submersion.agentName';

function loadAgentName(){
  try {
    return localStorage.getItem(AGENT_NAME_KEY) || '';
  } catch (e) {
    return '';
  }
}

function saveAgentName(name){
  localStorage.setItem(AGENT_NAME_KEY, name);
}

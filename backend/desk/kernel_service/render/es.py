"""Spanish: the visitor's status lines, key for key with `en.STATUS`."""

STATUS: dict[str, str] = {
    "allowed": "Revisado con las reglas de {owner}",
    "held": "Esperando la aprobación de {owner}",
    "refused": "No es algo que pueda hacer aquí",
    "approved": "{owner} lo aprobó",
    "denied": "{owner} decidió no seguir adelante",
    "expired": "Esta solicitud venció",
    "cancelled": "Cancelado",
    "executed": "Hecho",
    "failed": "No se pudo completar",
    "unknown": "Todavía lo estamos confirmando",
    "refused_at_execution": "Las reglas cambiaron, así que no se hizo",
    "reply_checked": "Respuesta revisada con las reglas de {owner}",
    "reply_handed_off": "Pasado a {owner} para responder",
}

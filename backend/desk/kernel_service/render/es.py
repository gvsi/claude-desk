"""Spanish: the visitor's status lines, executed receipts and other texts, key for key with
`en.STATUS`, `en.EXECUTED` and `en.MESSAGES`, the owner-only lines (`en.OWNER_STATUS`), and the
clause cards.

Cards read datetimes in the business's time zone ("martes 3 de noviembre, 14:00"), money as
`$1,234.56`, as in English, and percentages as "10 %".
"""

from datetime import datetime, time, timedelta

from desk.contracts import Fact, HoursWindow
from desk.kernel_service.render.cards import (Card, DeskInfo, booking_window, callback_window, claims, day_groups,
                                              hours_windows, local, money, percent_text, slot_claims, text_claim,
                                              title_claim)

STATUS: dict[str, str] = {
    "allowed": "Revisado con las reglas de {owner}",
    "held": "Esperando la aprobación de {owner}",
    "refused": "No es algo que pueda hacer aquí",
    "refused_over_mandate": "Rechazado: supera el límite firmado para este agente",
    "approved": "{owner} lo aprobó",
    "denied": "{owner} decidió no seguir adelante",
    "expired": "Esta solicitud venció",
    "cancelled": "Cancelado",
    "closed_by_booking": "Cerrada: su reserva sustituyó esta solicitud",
    "executed": "Hecho",
    "failed": "No se pudo completar",
    "unknown": "Todavía lo estamos confirmando",
    "refused_at_execution": "Las reglas cambiaron, así que no se hizo",
    "tool_unavailable": "Esto no está disponible ahora, así que no se hizo",
    "reply_checked": "Respuesta revisada con las reglas de {owner}",
    "reply_handed_off": "Pasado a {owner} para responder",
    "owner_said": "Escrito por {owner}",
    "owner_say_blocked": "No se envió: incluía texto de un documento privado",
}

# Owner-only (`en.OWNER_STATUS`): why an action was refused at execution, or that the visitor's booking
# closed a held request, a decision's `owner_plain`, kept out of `STATUS`, since a decision's status line
# reaches the visitor, who mustn't read why their session ended.
OWNER_STATUS: dict[str, str] = {
    "refused_contact_changed": "No se compartió: su sesión terminó cuando cambió su contacto",
    "refused_person_removed": "No se compartió: se quitó a esta persona de tus registros",
    "refused_session_closed": "No se compartió: su sesión terminó antes de tu respuesta",
    "refused_rules_changed": "Tus reglas cambiaron antes de que se hiciera, así que no se hizo.",
    "refused_desk_deleted": "Este Desk se eliminó antes de que se hiciera, así que no se hizo.",
    "refused_fallback": "No se pudo hacer, así que no se hizo.",
    "cancelled_by_booking": "El visitante reservó antes de que respondieras, así que esta solicitud se cerró.",
}

EXECUTED: dict[str, str] = {
    "purpose_payment": "{title}: enlace de pago creado",
    "urgent": "{title}: solicitud urgente enviada a {owner}",
    "intake": "{title}: datos guardados para {owner}",
    "typed_booking": "{title}: reservado en el calendario de {owner}",
    "native.quote": "Cotizado con la lista de precios de {owner}",
    "native.find_slots": "Horarios tomados del calendario de {owner}",
    "native.book": "Reservado en el calendario de {owner}",
    "native.capture_lead": "Datos guardados para {owner}",
    "native.request_callback": "Solicitud de llamada guardada para {owner}",
    "native.start_verification": "Verificación iniciada",
    "native.release_document": "Documento compartido desde los registros de {owner}",
    "native.payment_link": "Enlace de pago creado para esta cotización",
    "payments.list_charges": "Cargos tomados de los pagos de {owner}",
    "payments.create_refund": "Reembolsado al pago original",
    "native.charge_mandate": "Cobrado dentro del límite de tu mandato",
}

MESSAGES: dict[str, str] = {
    "verify_started": ("Si ese contacto está registrado, te enviamos un código. Escríbelo abajo para confirmar "
                       "que eres tú."),
    "verify_already": "Ya confirmaste quién eres en este chat.",
    "inbox_code_preview": "Nuevo código de verificación",
    "inbox_code_body": ("Tu código de {business} es {code}. Vence en diez minutos. "
                        "Si no lo pediste, ignora este mensaje."),
    "offer_callback": "¿Quiere que solicite una llamada?",
    "check_status": "Su solicitud está esperando aprobación; puede consultar su estado en este chat.",
}

WEEKDAYS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")
DAY_NAMES = dict(zip(("mon", "tue", "wed", "thu", "fri", "sat", "sun"), WEEKDAYS, strict=True))
MONTHS = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
          "noviembre", "diciembre")


def clock(moment: datetime | time) -> str:
    """"14:00"."""
    return f"{moment.hour}:{moment.minute:02d}"


def date(moment: datetime) -> str:
    """"martes 3 de noviembre"."""
    return f"{WEEKDAYS[moment.weekday()]} {moment.day} de {MONTHS[moment.month - 1]}"


def when(moment: datetime) -> str:
    """"martes 3 de noviembre, 14:00"."""
    return f"{date(moment)}, {clock(moment)}"


def listing(parts: list[str]) -> str:
    """"lunes", "lunes y miércoles", "lunes, miércoles y viernes"."""
    return parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} y {parts[-1]}"


def days_text(days: list[str]) -> str:
    """"de lunes a viernes", "sábado", "lunes, miércoles y viernes": three days or more in a row
    read as a range."""
    parts: list[str] = []
    for run in day_groups(days):
        if len(run) >= 3:
            parts.append(f"de {DAY_NAMES[run[0]]} a {DAY_NAMES[run[-1]]}")
        else:
            parts += [DAY_NAMES[day] for day in run]
    return listing(parts)


def window(hours_window: HoursWindow) -> str:
    """"De lunes a viernes, de 8:00 a 18:00", "Sábado, de 9:00 a 13:00"."""
    line = f"{days_text(hours_window.days)}, de {clock(hours_window.start)} a {clock(hours_window.end)}"
    return line[0].upper() + line[1:]


def quote(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total}` / `{items}` / `Incluye {pct} de descuento sobre {list}` / `Válido hasta {expires}`."""
    found = claims(fact)
    lines = [str(found["items"])]
    if found["discount"]:
        lines.append(f"Incluye {percent_text(found['discount'], ',')} % de descuento sobre {money(found['list'])}")
    lines.append(f"Válido hasta {when(local(found['expires'], desk))}")
    return Card(title=money(found["total"]), lines=tuple(lines))


def handoff(fact: Fact | None, desk: DeskInfo) -> Card:
    """`Déjame consultarlo con {owner}.` / `{owner} te responderá aquí.`, the first ending on the name's own full
    stop when it has one (a business name such as "Turner Plumbing, Inc.")."""
    owner = desk.owner
    stop = "" if owner.endswith(".") else "."
    return Card(title=f"Déjame consultarlo con {owner}{stop}", lines=(f"{owner} te responderá aquí.",))


def booking_options(fact: Fact | None, desk: DeskInfo) -> Card:
    """`Horarios disponibles` / una línea y una opción por horario libre."""
    options = tuple((slot_id, when(local(starts_at, desk))) for slot_id, starts_at in slot_claims(fact))
    return Card(title="Horarios disponibles", lines=tuple(label for _, label in options), options=options)


def hours(fact: Fact | None, desk: DeskInfo) -> Card:
    """Una línea por horario: `De lunes a viernes, de 8:00 a 18:00`."""
    first, *rest = [window(each) for each in hours_windows(fact)]
    return Card(title=first, lines=tuple(rest))


def booking_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{date}` / `De {start} a {end}` / `Con {owner}`; sin el ID de la reserva."""
    start, end = booking_window(fact, desk)
    found = claims(fact)
    if "appointment_type" in found:
        from desk.kernel_service.adapters.base import quoted
        return Card(title=date(start), lines=(f"{quoted(found['appointment_type'])} a las {clock(start)}",
                                              f"Unos {found['appointment_minutes']} minutos",
                                              f"Con {desk.owner}"))
    return Card(title=date(start), lines=(f"De {clock(start)} a {clock(end)}",
                                          f"Con {desk.owner}"))


def charter_text(fact: Fact | None, desk: DeskInfo) -> Card:
    """Una política o el contacto, tal como los escribió el negocio."""
    return Card(title=text_claim(fact))


def verify_prompt(fact: Fact | None, desk: DeskInfo) -> Card:
    return Card(title="Enviaré un código al contacto registrado.")


def callback_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{owner} te llamará el {day}, entre las {start} y las {end}`; sin horario `{owner} te llamará`.
    El hecho guarda solo el horario, nunca el texto del visitante."""
    owner = desk.owner
    window = callback_window(fact, desk)
    if window is None:
        return Card(title=f"{owner} te llamará")
    start, end = window
    return Card(title=f"{owner} te llamará el {date(start)}, entre las {clock(start)} y las {clock(end)}")


def owner_said(fact: Fact | None, desk: DeskInfo) -> Card:
    """Las palabras del dueño, tal como las escribió."""
    return Card(title=text_claim(fact))


def document_link(fact: Fact | None, desk: DeskInfo) -> Card:
    """El título del documento; el enlace va en el `href` de la tarjeta, que llena la revisión."""
    return Card(title=title_claim(fact))


def payment_link(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{título}, {total}`; el enlace va en el `href` de la tarjeta, que llena la revisión."""
    return Card(title=f"{title_claim(fact)}, {money(claims(fact)['total'])}")


def charges(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total}` / `{título}`, o `Pago` si el kernel no tiene uno / `{fecha y hora}` si el hecho la tiene:
    un pago anterior del cliente verificado."""
    found = claims(fact)
    lines = [title_claim(fact) if "title" in found else "Pago"]
    if "starts_at" in found:
        lines.append(when(local(found["starts_at"], desk)))
    return Card(title=money(found["total"]), lines=tuple(lines))


def refund_issued(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total} reembolsados`: lo que el reembolso devolvió al pago original."""
    return Card(title=f"{money(claims(fact)['total'])} reembolsados")


def charge_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{título}, {total}`, o `Pago, {total}` si el kernel no tiene un título: un cargo que se hizo,
    desde su hecho `charge` (el cargo de un agente dentro de su mandato, o un enlace pagado que Claude
    cita una vez conciliado)."""
    found = claims(fact)
    return Card(title=f"{title_claim(fact) if 'title' in found else 'Pago'}, {money(found['total'])}")


def payment_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{título}, {total}`: lo que pagó el pago de prueba, desde el hecho `charge` del enlace."""
    return Card(title=f"{title_claim(fact)}, {money(claims(fact)['total'])}")


def link_cancelled(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{total}` / `{título}` / `Este enlace de pago se canceló porque cambiaron las reglas de {dueño}.
    Pídelo de nuevo si todavía quieres pagar.`: la tarjeta del kernel para un enlace de pago que
    canceló un cambio de reglas, desde el hecho `payment_link` de ese mismo enlace."""
    return Card(title=money(claims(fact)["total"]), lines=(
        title_claim(fact),
        f"Este enlace de pago se canceló porque cambiaron las reglas de {desk.owner}. "
        "Pídelo de nuevo si todavía quieres pagar."))


# ---- La línea de abierto ahora de la cabecera pública ("Open status") --------------------------------

def _day(moment: datetime, as_of: datetime) -> str:
    """La fecha de `moment` vista desde `as_of`: "hoy", "mañana", "el próximo lunes" para el mismo
    día de la semana dentro de siete días, si no "el lunes". Una fecha a más de una semana, o ya
    pasada, no tiene palabra y lanza ValueError."""
    ahead = (moment.date() - as_of.date()).days
    if ahead == 0:
        return "hoy"
    if ahead == 1:
        return "mañana"
    if 2 <= ahead <= 7:
        return f"el {'próximo ' if ahead == 7 else ''}{WEEKDAYS[moment.weekday()]}"
    raise ValueError("an open-now day is within the week ahead")


def _at(moment: datetime) -> str:
    """"las 18:00", "la 1:00": la hora con su artículo, "la" para la una."""
    return f"{'la' if moment.hour == 1 else 'las'} {clock(moment)}"


def _until(moment: datetime, as_of: datetime) -> str:
    """Hasta cuándo abre: "las 18:00", "mañana a las 2:00", "el sábado a las 2:00". Un cierre a las
    0:00 es la medianoche del día anterior, que lleva la palabra del día: "la medianoche", "mañana a
    medianoche", "el viernes a medianoche"."""
    if (moment.hour, moment.minute) == (0, 0):
        day = _day(moment - timedelta(days=1), as_of)
        return "la medianoche" if day == "hoy" else f"{day} a medianoche"
    day = _day(moment, as_of)
    return _at(moment) if day == "hoy" else f"{day} a {_at(moment)}"


def open_status(is_open: bool, boundary: datetime | None, as_of: datetime) -> str:
    """"Abierto ahora, hasta las 18:00", "Abierto ahora", "Cerrado ahora. Abre el lunes a las 8:00":
    `boundary` y `as_of` en la zona horaria del negocio."""
    if is_open:
        return "Abierto ahora" if boundary is None else f"Abierto ahora, hasta {_until(boundary, as_of)}"
    if boundary is None:
        raise ValueError("a closed business names when it opens")
    return f"Cerrado ahora. Abre {_day(boundary, as_of)} a {_at(boundary)}"


# La tarjeta para agentes de la página pública (`render.agent_card`), clave por clave con `en`.
AGENT_TOOLS: dict[str, str] = {
    "native.quote": "Pedir una cotización de la lista de precios",
    "native.find_slots": "Buscar horarios libres",
    "native.book": "Reservar una visita",
    "native.payment_link": "Pedir un enlace de pago para una cotización",
    "native.charge_mandate": "Pagar una cotización dentro del límite de un mandato firmado",
    "native.capture_lead": "Dejar datos de contacto",
    "native.request_callback": "Pedir que te devuelvan la llamada",
    "native.start_verification": "Verificar a un cliente con un código enviado a su contacto registrado",
    "native.release_document": "Recibir los documentos propios de un cliente verificado",
    "payments.list_charges": "Ver los cargos propios de un cliente verificado",
}

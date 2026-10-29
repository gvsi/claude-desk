"""Spanish: the visitor's status lines and other texts, key for key with `en.STATUS` and
`en.MESSAGES`, and the clause cards.

Cards read datetimes in the business's time zone ("martes 3 de noviembre, 14:00"), money as
`$1,234.56`, as in English, and percentages as "10 %".
"""

from datetime import datetime, time

from desk.contracts import Fact, HoursWindow
from desk.kernel_service.render.cards import (Card, DeskInfo, booking_window, claims, day_groups, hours_windows, local,
                                              money, percent_text, slot_claims, text_claim)

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

MESSAGES: dict[str, str] = {
    "verify_started": ("Si ese contacto está registrado, te enviamos un código. Escríbelo abajo para confirmar "
                       "que eres tú."),
    "verify_already": "Ya confirmaste quién eres en este chat.",
    "inbox_code_preview": "Nuevo código de verificación",
    "inbox_code_body": ("Tu código de {business} es {code}. Vence en diez minutos. "
                        "Si no lo pediste, ignora este mensaje."),
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
    """`Déjame consultarlo con {owner}.` / `{owner} te responderá aquí.`"""
    owner = desk.owner_display_name
    return Card(title=f"Déjame consultarlo con {owner}.", lines=(f"{owner} te responderá aquí.",))


def booking_options(fact: Fact | None, desk: DeskInfo) -> Card:
    """`Horarios disponibles` / una línea y una opción por horario libre."""
    options = tuple((slot_id, when(local(starts_at, desk))) for slot_id, starts_at in slot_claims(fact))
    return Card(title="Horarios disponibles", lines=tuple(label for _, label in options), options=options)


def hours(fact: Fact | None, desk: DeskInfo) -> Card:
    """Una línea por horario: `De lunes a viernes, de 8:00 a 18:00`."""
    first, *rest = [window(each) for each in hours_windows(fact)]
    return Card(title=first, lines=tuple(rest))


def booking_confirmed(fact: Fact | None, desk: DeskInfo) -> Card:
    """`{date}` / `Llegada de {start} a {end}` / `Con {owner}`; sin el ID de la reserva."""
    start, end = booking_window(fact, desk)
    return Card(title=date(start), lines=(f"Llegada de {clock(start)} a {clock(end)}",
                                          f"Con {desk.owner_display_name}"))


def charter_text(fact: Fact | None, desk: DeskInfo) -> Card:
    """Una política o el contacto, tal como los escribió el negocio."""
    return Card(title=text_claim(fact))


def verify_prompt(fact: Fact | None, desk: DeskInfo) -> Card:
    return Card(title="Enviaré un código al contacto registrado.")

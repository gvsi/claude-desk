"""Public policy examples shared by scanner, service and both contract targets."""

AMENITY_REFUSALS = [
    *[(text, "lex.en.promise") for text in (
        "Free water heater flush.", "Free water heater flush with every repair.",
        "Free water heater inspection.", "Free water heater inspections.",
        "Complimentary water heater inspection.", "Free parking and drain clearing.",
        "Free parking and repairs.", "Free snacks and diagnostics.",
        "Free parking + consultations.", "Free coffee and on-site estimates.",
    )],
    *[(text, "lex.es.promise") for text in (
        "Calentador de agua gratis.", "Revisión y agua gratis.", "Instalación y café gratis.",
    )],
]
AMENITY_ACCEPTED = ["Free parking for consultations.", "Ofrecemos café gratis."]

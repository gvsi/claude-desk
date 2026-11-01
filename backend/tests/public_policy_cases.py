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

AI_DENIAL_REFUSALS = [(text, "policy.ai_denial") for text in (
    "I'm a human receptionist.", "I am a human assistant.", "I'm a human agent here to help.",
    "I'm a human representative.", "I'm human and happy to help.", "I'm human too.",
    "Soy una persona.", "Soy una recepcionista humana.", "Soy un recepcionista humano.",
    "Soy una agente humana.", "Soy un agente humano.", "Soy una asistente humana.",
    "You'll be talking to a human.", "You will be chatting with a real person.",
    "You’ll be speaking with a person.",
    "Call us. You'll be talking to a human.",
)]
AI_DENIAL_CONTROLS = [
    "No soy una persona, soy una IA.", "No soy una recepcionista humana.",
    "You'll be talking to a real person when you call.",
    "Call us and you'll be talking to a real person.",
    "If you call, you'll be speaking with a person, not a machine.",
    "You'll be speaking with a human resources consultant.",
    "You'll be speaking with a person by phone.",
    "You'll be talking to a person once you visit.",
]

HUMAN_OCCUPATIONS = [
    "I am a human resource consultant.", "I'm a human relations consultant.",
    "I am a human factors engineer.", "I'm a human services worker.", "I am a human biology tutor.",
    "Human factors engineer.", "Human services worker.", "Human biology tutor.",
]

CONTACT_FORMS = [
    "Call or text us at (510) 555-0142", "Text or call (510) 555-0142",
    "(510) 555-0142 (call or text)", "WhatsApp: +1 510 555 0142", "calendly.com/maria-rivera/30min",
]

COST_AMENITIES = ["No cost parking.", "No-cost parking.", "Parking costs nothing.", "Coffee and water cost nothing."]
COST_SERVICE_REFUSALS = [
    ("No cost repairs.", "lex.en.promise"), ("No-cost water heater flush.", "lex.en.promise"),
    ("Parking and repairs cost nothing.", "policy.free_price"),
    ("Water heater inspections cost nothing.", "policy.free_price"),
]

PAYMENT_TIMING = [
    "No cobramos nada hasta terminar el trabajo.", "No cobramos nada por adelantado.",
    "No le cobramos nada hasta que apruebe el presupuesto.", "No cuesta nada hasta que el trabajo esté hecho.",
]

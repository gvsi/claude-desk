/**
 * The kernel's verdicts on sentences, for the differential test in `factInProse.test.ts`: each case
 * is a text, the cards beside it where they matter, and the hits the kernel's prose scan reports on
 * it, as sorted `[rule, span]` pairs, the span being the whole match in `shown(text)`. The verdicts
 * are the kernel's `_prose_hits` (`backend/desk/kernel_service/reply_check.py`) at commit a8ed7b302
 * (name the new commit when refreshing them).
 * The cases hold the sentences `factInProse.test.ts` checks (a sample of those it builds from parts),
 * the signed vision lines, one or more for each way the kernel reads text, and honest lines that
 * must pass.
 *
 * Characters outside printable ASCII, ’ and the Latin-1 letters are written as escapes, so a
 * lookalike or an unseen character shows. To add a case, add its line with empty hits; to refresh
 * every verdict from the kernel, run this from `backend/`:
 *
 * uv run python -c 'import json,re;from desk.kernel_service.reply_check import _prose_hits as h,shown;p="../web/src/ds/boards/factInProse.kernel.ts";s=open(p).read();f=lambda c:{**c,"hits":sorted([r,shown(c["text"])[a:b]] for a,b,r,_ in h(c["text"],booking_card=c.get("bookingCard",False),callback_card=c.get("callbackCard",False)))};open(p,"w").write(re.sub(r"(?m)^  (\{.*\}),$",lambda m:"  "+re.sub(r"[^ -~’À-ÿ]",lambda x:json.dumps(x[0])[1:-1],json.dumps(f(json.loads(m[1])),ensure_ascii=False))+",",s))'
 */

/** One sentence and what the kernel reports on it. */
export interface KernelCase {
  text: string;
  bookingCard?: boolean;
  callbackCard?: boolean;
  /** The kernel's hits: its rule id and the words, sorted. */
  hits: readonly (readonly [string, string])[];
}

/** The cases, one per line, as the command above reads and writes them. */
export const KERNEL_CASES: readonly KernelCase[] = [
  {"text": "Mike arrives at 2.", "hits": [["digit", "2"]]},
  {"text": "Llega a las \u0662.", "hits": [["digit", "\u0662"]]},
  {"text": "That’s $ well spent.", "hits": [["currency", "$"]]},
  {"text": "It’s 50% off.", "hits": [["digit", "50"], ["percent_sign", "%"]]},
  {"text": "It takes two visits.", "hits": [["lex.en.number", "two"]]},
  {"text": "Son dos visitas.", "hits": [["lex.es.number", "dos"]]},
  {"text": "It costs a few bucks.", "hits": [["lex.en.money", "bucks"]]},
  {"text": "Cuesta unos dólares.", "hits": [["lex.es.money", "dólares"]]},
  {"text": "Ten percent off.", "hits": [["lex.en.number", "Ten"], ["lex.en.percent", "percent"]]},
  {"text": "Un por ciento menos.", "hits": [["lex.es.number", "ciento"], ["lex.es.percent", "por ciento"]]},
  {"text": "See you on Tuesday.", "hits": [["lex.en.date", "Tuesday"]]},
  {"text": "Come by tomorrow.", "hits": [["lex.en.date", "tomorrow"]]},
  {"text": "We close in May.", "hits": [["lex.en.date", "in May"]]},
  {"text": "Nos vemos el miércoles.", "hits": [["lex.es.date", "miércoles"]]},
  {"text": "I guarantee it.", "hits": [["lex.en.promise", "guarantee"]]},
  {"text": "That one is free.", "hits": [["lex.en.promise", "free"]]},
  {"text": "Te damos un descuento.", "hits": [["lex.es.promise", "descuento"]]},
  {"text": "It comes at no extra charge.", "hits": [["lex.en.promise", "no extra charge"]]},
  {"text": "There’s no set cost until Mike sees the leak.", "hits": [["lex.en.promise", "no set cost"]]},
  {"text": "No standard fees will be charged.", "hits": [["lex.en.promise", "No standard fees"]]},
  {"text": "No worries about costs; you pay nothing.", "hits": [["lex.en.promise", "No worries about costs"]]},
  {"text": "There’s no set up fee.", "hits": [["lex.en.promise", "no set up fee"]]},
  {"text": "There’s no set up charge.", "hits": [["lex.en.promise", "no set up charge"]]},
  {"text": "Sin recargos.", "hits": [["lex.es.promise", "Sin recargos"]]},
  {"text": "No hay cargo extra.", "hits": [["lex.es.promise", "No hay cargo"]]},
  {"text": "Your appointment is confirmed.", "hits": [["lex.en.booking", "Your appointment is confirmed"]]},
  {"text": "You’re all set.", "hits": [["lex.en.booking", "You’re all set"]]},
  {"text": "Booking confirmed.", "hits": [["lex.en.booking", "Booking confirmed"]]},
  {"text": "Tu cita está confirmada.", "hits": [["lex.es.booking", "Tu cita está confirmada"]]},
  {"text": "Sí, está confirmada.", "hits": [["lex.es.booking", "está confirmada"]]},
  {"text": "You may call Mike.", "hits": []},
  {"text": "Once your visit is confirmed, Mike texts you.", "hits": []},
  {"text": "Cuando tu cita está confirmada, te escribimos.", "hits": []},
  {"text": "Your appointment is confirmed.", "bookingCard": true, "hits": []},
  {"text": "Next\u2010week works.", "hits": [["lex.en.date", "Next\u2010week"]]},
  {"text": "You\u02bcre   all set.", "hits": [["lex.en.booking", "You\u02bcre   all set"]]},
  {"text": "Mañana.", "hits": [["lex.es.date", "Mañana"]]},
  {"text": "Here’s Ana’s history. The gate code is on her job card.", "hits": []},
  {"text": "Here it is.", "hits": []},
  {"text": "I can’t share pay. Payroll is open to Mike and Grace only. Here are your own logged hours.", "hits": []},
  {"text": "Your Claude account has a verified email. If it matches the contact Turner Plumbing has on record for you, I can confirm it’s you without a code. Use it for this visit?", "hits": []},
  {"text": "Welcome back, Dana. How did the drain clearing go?", "hits": []},
  {"text": "Glad to hear it. Here’s your invoice. You let me use your Claude account for this visit, so no code was needed.", "hits": []},
  {"text": "I can look that up after you confirm it’s you.", "hits": []},
  {"text": "Thanks, Marcus. Here’s where your kitchen remodel stands.", "hits": []},
  {"text": "Here’s what comes next.", "hits": []},
  {"text": "These times are open on the inspection calendar. Which one works for you?", "hits": []},
  {"text": "Whether your garage conversion needs a permit is a plan checker’s decision. I’ve asked Permit Center staff, and the answer will show up here.", "hits": []},
  {"text": "You’re all set. Here’s your visit.", "hits": [["lex.en.booking", "You’re all set"]]},
  {"text": "You’re all set. Here’s your visit.", "bookingCard": true, "hits": []},
  {"text": "Your appointment and call are booked.", "hits": [["lex.en.booking", "Your appointment and call are booked"], ["lex.en.callback", "Your appointment and call are booked"]]},
  {"text": "Your appointment and call are booked.", "bookingCard": true, "hits": [["lex.en.callback", "Your appointment and call are booked"]]},
  {"text": "Your table and call are confirmed.", "callbackCard": true, "hits": [["lex.en.booking", "Your table and call are confirmed"]]},
  {"text": "Tu cita y tu llamada están confirmadas.", "hits": [["lex.es.booking", "están confirmadas"], ["lex.es.callback", "y tu llamada están confirmadas"]]},
  {"text": "Ya están confirmadas tu llamada y tu cita.", "bookingCard": true, "hits": [["lex.es.callback", "Ya están confirmadas tu llamada"]]},
  {"text": "Your call is confirmed.", "callbackCard": true, "hits": []},
  {"text": "Your call with Mike is confirmed.", "bookingCard": true, "hits": [["lex.en.callback", "Your call with Mike is confirmed"]]},
  {"text": "Your callback request is confirmed.", "hits": [["lex.en.callback", "Your callback request is confirmed"]]},
  {"text": "Your follow-up-call is confirmed.", "callbackCard": true, "hits": []},
  {"text": "Tu llamada está confirmada.", "bookingCard": true, "hits": [["lex.es.callback", "Tu llamada está confirmada"]]},
  {"text": "We've booked your appointment\u2014call us for details.", "callbackCard": true, "hits": [["lex.en.booking", "We've booked your appointment"]]},
  {"text": "Your service call is set up.", "hits": [["lex.en.booking", "Your service call is set"]]},
  {"text": "Your emergency service-call is set to proceed.", "bookingCard": true, "hits": []},
  {"text": "Your service call with Mike is set up.", "callbackCard": true, "hits": [["lex.en.booking", "Your service call with Mike is set"]]},
  {"text": "Your account is set up.", "hits": []},
  {"text": "Your workspace is set up.", "hits": []},
  {"text": "You said you'd booked a consultation\u2014Booked your appointment.", "hits": [["lex.en.booking", "Booked your appointment"]]},
  {"text": "You said you'd booked a callback; Booked your call.", "callbackCard": true, "hits": []},
  {"text": "- You said you'd booked a consultation\n- Booked your call.", "hits": [["lex.en.callback", "Booked your call"]]},
  {"text": "You said you'd booked a callback, Booked your appointment.", "bookingCard": true, "hits": []},
  {"text": "- You said you'd booked a consultation\n* Booked your appointment.", "bookingCard": true, "callbackCard": true, "hits": []},
  {"text": "You said you'd booked a callback/ Booked your call.", "hits": [["lex.en.callback", "Booked your call"]]},
  {"text": "Your identity is confirmed.", "hits": []},
  {"text": "Your IDENTITY is confirmed.", "hits": []},
  {"text": "Your contact details are confirmed.", "hits": []},
  {"text": "Your custom workspace is set to receive messages.", "hits": []},
  {"text": "Have you previously booked a consultation with us?", "hits": []},
  {"text": "You said you'd booked a consultation with us before.", "hits": []},
  {"text": "If you have already booked a consultation, I can help with it.", "hits": []},
  {"text": "Si te hemos reservado una mesa, puedo buscar la confirmación.", "hits": []},
  {"text": "Si ya hemos reservado tu mesa, puedo buscar la confirmación.", "hits": []},
  {"text": "Once your follow-up-call is confirmed, we can discuss access.", "hits": []},
  {"text": "Your IDENTITY is confirmed. Your consultation is confirmed.", "hits": [["lex.en.booking", "Your consultation is confirmed"]]},
  {"text": "If you have already booked a consultation, I can help with it. Your consultation is confirmed.", "hits": [["lex.en.booking", "Your consultation is confirmed"]]},
  {"text": "Tu llamada está confirmada. Está confirmada.", "hits": [["lex.es.booking", "Está confirmada"], ["lex.es.callback", "Tu llamada está confirmada"]]},
  {"text": "Your call WITH Mike is confirmed.", "callbackCard": true, "hits": []},
  {"text": "Your appointment with Mike is set up.", "hits": [["lex.en.booking", "Your appointment with Mike is set"]]},
  {"text": "It costs tweIve doIIars.", "hits": [["lex.en.money", "doIIars"], ["lex.en.number", "tweIve"]]},
  {"text": "You\u00b4re all set.", "hits": [["lex.en.booking", "You \u0301re all set"]]},
  {"text": "See you on Tu\u0435sday.", "hits": [["lex.en.date", "Tu\u0435sday"], ["mixed_script", "Tu\u0435sday"]]},
  {"text": "It takes \u039d\u0399\u039d\u0395 visits.", "hits": [["lex.en.number", "\u039d\u0399\u039d\u0395"]]},
  {"text": "Your caII is confirmed.", "bookingCard": true, "hits": [["lex.en.callback", "Your caII is confirmed"]]},
  {"text": "IF your table is confirmed, we text you.", "hits": []},
  {"text": "The gate code is \u0417.", "hits": [["digit", "\u0417"]]},
  {"text": "The gate code is 2\u041e\u041e.", "hits": [["digit", "2\u041e\u041e"]]},
  {"text": "Room \u0406\u041e\u041e is upstairs.", "hits": [["digit", "\u0406\u041e\u041e"]]},
  {"text": "I can check. OK?", "hits": []},
  {"text": "Mike says lO is fine.", "hits": []},
  {"text": "See you on Tues\u034fday.", "hits": [["lex.en.date", "Tuesday"]]},
  {"text": "Come by tomor\ufe0frow.", "hits": [["lex.en.date", "tomorrow"]]},
  {"text": "It takes tw\u200bo visits.", "hits": [["lex.en.number", "two"]]},
  {"text": "Your\u3164appointment is confirmed.", "hits": [["lex.en.booking", "Your appointment is confirmed"]]},
  {"text": "It costs twelve\uffa0dollars.", "hits": [["lex.en.money", "dollars"], ["lex.en.number", "twelve"]]},
  {"text": "It opens at five o\u00b4clock.", "hits": [["lex.en.date", "o \u0301clock"], ["lex.en.number", "five"]]},
  {"text": "It comes at no\u00b4charge.", "hits": [["lex.en.promise", "no \u0301charge"]]},
  {"text": "Ask M\u0456ke about it.", "hits": [["mixed_script", "M\u0456ke"]]},
  {"text": "Y\u043eur appointment is confirmed.", "bookingCard": true, "hits": [["mixed_script", "Y\u043eur"]]},
  {"text": "\uff33\uff45\uff45 you \uff54\uff4f\uff4d\uff4f\uff52\uff52\uff4f\uff57.", "hits": [["lex.en.date", "tomorrow"]]},
  {"text": "It costs a few buck\ud806\udcc1.", "hits": [["lex.en.money", "buck\ud806\udcc1"], ["mixed_script", "buck\ud806\udcc1"]]},
  {"text": "You\u00b4re aII set.", "hits": [["lex.en.booking", "You \u0301re aII set"]]},
  {"text": "It’s \u2132ree.", "hits": [["mixed_script", "\u2132ree"]]},
  {"text": "Ask a\u214e about it.", "hits": [["mixed_script", "a\u214e"]]},
  {"text": "May I take your name?", "hits": []},
  {"text": "I can help with that. OK, I’ll ask Mike.", "hits": []},
  {"text": "If it’s urgent, I can ask Mike to call you.", "hits": []},
];

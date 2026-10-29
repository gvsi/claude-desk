// Test fixture: set H, a hold twin of every auto card (scope only, no review
// gate or limits) and the default ask for every other visitor or agent tool.

@id("find_slots_twin")
@card("c-find-slots")
@tier("hold")
@applies_to("native.find_slots")
permit (principal, action == Action::"native.find_slots", resource);

@id("quote_twin")
@card("c-quote")
@tier("hold")
@applies_to("native.quote")
permit (principal, action == Action::"native.quote", resource);

@id("payment_link_twin")
@card("c-deposit")
@tier("hold")
@applies_to("native.payment_link")
permit (principal is Visitor, action == Action::"native.payment_link", resource);

@id("default_book")
@card("default:native.book")
@tier("hold")
@applies_to("native.book")
permit (principal, action == Action::"native.book", resource);

@id("default_release_document")
@card("default:native.release_document")
@tier("hold")
@applies_to("native.release_document")
permit (principal, action == Action::"native.release_document", resource);

@id("default_charge_mandate")
@card("default:native.charge_mandate")
@tier("hold")
@applies_to("native.charge_mandate")
permit (principal, action == Action::"native.charge_mandate", resource);

@id("default_capture_lead")
@card("default:native.capture_lead")
@tier("hold")
@applies_to("native.capture_lead")
permit (principal, action == Action::"native.capture_lead", resource);

@id("default_request_callback")
@card("default:native.request_callback")
@tier("hold")
@applies_to("native.request_callback")
permit (principal, action == Action::"native.request_callback", resource);

@id("default_start_verification")
@card("default:native.start_verification")
@tier("hold")
@applies_to("native.start_verification")
permit (principal, action == Action::"native.start_verification", resource);

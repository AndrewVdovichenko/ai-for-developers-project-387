import "@typespec/http";
import "@typespec/openapi3";
using TypeSpec.Http;
@service(#{ title: "Календарь звонков API" })
@server("http://127.0.0.1:3000", "Локальная разработка")
namespace Calendar;
@get
@route("/health")
op getStatus(): { status: "ok" };

model Session {
  authenticated: boolean;
  expiresAt: string | null;
  serverNow: string;
}
model SessionStatus extends Session { configured: boolean; }
model ApiError {
  code: "INVALID_REQUEST" | "OWNER_AUTH_REQUIRED" | "INVALID_PASSWORD" | "ORIGIN_NOT_ALLOWED" | "OWNER_NOT_CONFIGURED" | "LOGIN_RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE" | "INTERNAL_ERROR" | "VALIDATION_FAILED" | "IDEMPOTENCY_KEY_REQUIRED" | "IDEMPOTENCY_KEY_REUSED" | "EVENT_TYPE_NOT_FOUND" | "REVISION_CONFLICT" | "PREVIEW_REQUIRED" | "GUEST_SESSION_REQUIRED" | "HOLD_UNAVAILABLE" | "SLOT_UNAVAILABLE" | "SLOT_STARTED" | "SLOT_NO_LONGER_OFFERED" | "HOLD_ALREADY_CONFIRMED" | "HOLD_REPLACED" | "HOLD_RELEASED" | "BOOKING_UNAVAILABLE" | "INVALID_FILTER";
  message: string;
  fieldErrors?: { field: string; code: string; message: string }[];
  retryAfterSeconds?: int32;
}
model BadRequest { @statusCode statusCode: 400; @body body: ApiError; }
model Unauthorized { @statusCode statusCode: 401; @body body: ApiError; }
model Forbidden { @statusCode statusCode: 403; @body body: ApiError; }
model RateLimited { @statusCode statusCode: 429; @header("Retry-After") retryAfter: int32; @body body: ApiError; }
model Unavailable { @statusCode statusCode: 503; @body body: ApiError; }
model InternalError { @statusCode statusCode: 500; @body body: ApiError; }
@route("/api/owner/session")
namespace OwnerSession {
  @get op getOwnerSession(): SessionStatus | Unavailable | InternalError;
  @post op loginOwner(@body body: { password: string }): Session | BadRequest | Unauthorized | Forbidden | RateLimited | Unavailable | InternalError;
  @delete op logoutOwner(): NoContentResponse | Forbidden | Unavailable | InternalError;
}

model EventType {
  @format("uuid") id: string;
  name: string;
  description: string;
  durationMinutes: int32;
}
model CreateEventType {
  @doc("Название после trim: 1–100 кодовых точек; U+0000 запрещён.")
  @pattern("^[^\\u0000]*$") name: string;
  @doc("До 2000 кодовых точек; переносы сохраняются, U+0000 запрещён.")
  @pattern("^[^\\u0000]*$") description?: string;
  durationMinutes: int32;
}
model EventTypeCreated { eventType: EventType; }
model NotFound { @statusCode statusCode: 404; @body body: ApiError; }
model Conflict { @statusCode statusCode: 409; @body body: ApiError; }
model OperationResponse { status: int32; body: EventTypeCreated | AvailabilityResponse | HoldResponse | BookingResponse | ApiError; }
union OperationResult {
  { state: "unknown" },
  { state: "completed"; response: OperationResponse; }
}
@route("/api/event-types")
namespace EventTypes {
  @get op listEventTypes(): { items: EventType[] } | Unavailable | InternalError;
  @get @route("/{id}") op getEventType(@path id: string): EventType | NotFound | Unavailable | InternalError;
}
@route("/api/owner/event-types")
@post op createEventType(@header("Idempotency-Key") key: string, @body body: CreateEventType):
  { @statusCode statusCode: 201; @body body: EventTypeCreated } | BadRequest | Unauthorized | Forbidden | Conflict | Unavailable | InternalError;
@route("/api/owner/operations/{key}")
@get op getOwnerOperation(@path key: string): OperationResult | BadRequest | Unauthorized | Unavailable | InternalError;

model WorkingInterval {
  @minValue(0) @maxValue(1439) startMinute: int32;
  @minValue(1) @maxValue(1440) endMinute: int32;
}
model WeeklyDay {
  @minValue(1) @maxValue(7) weekday: int32;
  intervals: WorkingInterval[];
}
model AvailabilitySettings {
  configured: boolean;
  timeZone: string | null;
  revision: int32;
  @doc("Ровно семь неповторяющихся дней: понедельник 1 — воскресенье 7.") days: WeeklyDay[];
}
model AvailabilityResponse { availability: AvailabilitySettings; serverNow: string; }
model SaveAvailability {
  @minValue(0) revision: int32;
  timeZone: string;
  @doc("Ровно семь неповторяющихся дней: понедельник 1 — воскресенье 7.") days: WeeklyDay[];
  confirmationToken?: string;
}
model PreviewAvailability { revision: int32; timeZone: string; days: WeeklyDay[]; }
model AffectedInterval { id: string; eventTypeId: string; eventTypeName: string; startsAt: string; endsAt: string; }
model AffectedHold extends AffectedInterval { expiresAt: string; }
model AvailabilityPreview { confirmationToken: string; expiresAt: string; serverNow: string; affectedBookings: AffectedInterval[]; affectedHolds: AffectedHold[]; }
@route("/api/owner/availability")
namespace OwnerAvailability {
  @route("/preview") @post op previewAvailability(@body body: PreviewAvailability): AvailabilityPreview | BadRequest | Unauthorized | Forbidden | Conflict | Unavailable | InternalError;
  @get op getAvailability(): AvailabilityResponse | Unauthorized | Unavailable | InternalError;
  @put op saveAvailability(@header("Idempotency-Key") key: string, @body body: SaveAvailability): AvailabilityResponse | BadRequest | Unauthorized | Forbidden | Conflict | Unavailable | InternalError;
}

/** Concrete UTC instants always include milliseconds and Z. */
@pattern("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
scalar UtcInstant extends string;
model Slot { startsAt: UtcInstant; endsAt: UtcInstant; }
model SlotAvailability {
  configured: boolean;
  serverNow: UtcInstant;
  timeZone: string | null;
  windowStartsAt: UtcInstant | null;
  windowEndsAt: UtcInstant | null;
  slots: Slot[];
}
@route("/api/event-types/{id}/availability")
@get op getSlotAvailability(@path id: string): SlotAvailability | NotFound | Unavailable | InternalError;

model Hold {
  id: string;
  eventTypeId: string;
  startsAt: UtcInstant;
  endsAt: UtcInstant;
  expiresAt: UtcInstant;
  state: "active" | "expired" | "released" | "replaced" | "confirmed";
  bookingId: string | null;
}
model HoldResponse { hold: Hold; serverNow: UtcInstant; }
@route("/api/guest-session") namespace GuestSession {
  @get op verifyGuest(): { ready: boolean } | Unavailable | InternalError;
  @post op prepareGuest(@body body: {}): { ready: boolean } | BadRequest | Forbidden | Unavailable | InternalError;
}
@route("/api/holds") @post op selectHold(@header("Idempotency-Key") key: string, @body body: { eventTypeId: string; startsAt: UtcInstant }): HoldResponse | BadRequest | Unauthorized | Forbidden | NotFound | Conflict | Unavailable | InternalError;
@route("/api/holds/current") @get op getCurrentHold(): { hold: Hold | null; serverNow: UtcInstant } | Unauthorized | Unavailable | InternalError;
@route("/api/holds/{id}") @get op getHold(@path id: string): HoldResponse | NotFound | Unavailable | InternalError;
@route("/api/operations/{key}") @get op getGuestOperation(@path key: string): OperationResult | BadRequest | Unauthorized | Unavailable | InternalError;

@route("/api/holds/{id}/release") @post op releaseHold(@path id: string, @header("Idempotency-Key") key: string, @body body: {}): HoldResponse | BadRequest | Unauthorized | Forbidden | NotFound | Conflict | Unavailable | InternalError;

model Booking {
  id: string;
  holdId: string;
  eventTypeId: string;
  eventTypeName: string;
  startsAt: UtcInstant;
  endsAt: UtcInstant;
  guestName: string;
  guestEmail: string;
}
model BookingResponse { booking: Booking; serverNow: UtcInstant; }
model ConfirmBooking {
  @doc("Обязательное имя: 1–100 кодовых точек после trim.") guestName: string;
  @doc("До 254 кодовых точек после trim; регистр сохраняется, формат ^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$ с флагом u.") guestEmail: string;
}
@route("/api/holds/{id}/confirm") @post op confirmHold(@path id: string, @header("Idempotency-Key") key: string, @body body: ConfirmBooking): BookingResponse | BadRequest | Unauthorized | Forbidden | NotFound | Conflict | Unavailable | InternalError;
@route("/api/bookings/{id}") @get op getBooking(@path id: string): BookingResponse | NotFound | Unavailable | InternalError;

model OwnerBookings { items: Booking[]; serverNow: UtcInstant; }
@route("/api/owner/bookings") @get op listOwnerBookings(
  @query(#{ explode: true }) eventTypeId?: string[],
): OwnerBookings | BadRequest | Unauthorized | Unavailable | InternalError;

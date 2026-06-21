// netlify/functions/find-doctors.js
//
// This is a serverless function. It runs on Netlify's servers, not in the
// browser — that's important because it lets us safely call external APIs
// without exposing any keys (the LocationIQ key below stays on the server,
// never visible to anyone visiting the website).
//
// It does two things:
// 1. Asks LocationIQ's Search/Geocoding service "where is this city?"
// 2. Asks LocationIQ's Nearby API "what clinics/hospitals/doctors exist near there?"
//
// LocationIQ is built on OpenStreetMap data, has a generous free tier
// (5,000 requests/day), and does not require a credit card to sign up —
// which makes it a more reliable alternative to the free public Overpass
// API instances, which can become overloaded and reject requests.

const LOCATIONIQ_KEY = Netlify.env.get("LOCATIONIQ_API_KEY");

export default async (req) => {
  try {
    if (!LOCATIONIQ_KEY) {
      return new Response(
        JSON.stringify({ error: "Server is missing its LocationIQ API key. Please contact the site owner." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const url = new URL(req.url);
    const city = url.searchParams.get("city");
    const specialty = url.searchParams.get("specialty") || "";

    if (!city || city.trim().length < 2) {
      return new Response(
        JSON.stringify({ error: "Please provide a city name." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 1: turn the city name into coordinates using LocationIQ's
    // forward geocoding (search) endpoint.
    const geoRes = await fetch(
      `https://us1.locationiq.com/v1/search?key=${LOCATIONIQ_KEY}&q=${encodeURIComponent(city)}&format=json&limit=1`
    );

    if (!geoRes.ok) {
      return new Response(
        JSON.stringify({ error: "Could not look up that city right now. Please try again shortly." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const geoData = await geoRes.json();

    if (!geoData || geoData.length === 0 || geoData.error) {
      return new Response(
        JSON.stringify({ error: `We couldn't find a city called "${city}". Try checking the spelling.` }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);

    // Step 2: search LocationIQ's Nearby API for medical places within ~6km.
    const radiusMeters = 6000;
    const tags = "amenity:clinic,amenity:doctors,amenity:hospital";
    const nearbyRes = await fetch(
      `https://us1.locationiq.com/v1/nearby?key=${LOCATIONIQ_KEY}&lat=${lat}&lon=${lon}&tag=${encodeURIComponent(tags)}&radius=${radiusMeters}&format=json&limit=30`
    );

    if (!nearbyRes.ok) {
      return new Response(
        JSON.stringify({ error: "The doctor directory is busy right now. Please try again in a moment." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const nearbyData = await nearbyRes.json();

    // If LocationIQ found zero results, it returns an {error: "..."} object
    // instead of an array — handle that gracefully rather than crashing.
    const rawResults = Array.isArray(nearbyData) ? nearbyData : [];

    // Step 3: shape the raw data into something clean for the frontend.
    let results = rawResults
      .map((place) => {
        const addr = place.address || {};
        const name = place.name || addr.name;
        if (!name) return null; // skip unnamed entries, not useful to show

        return {
          name,
          type: place.type, // "clinic", "doctors", or "hospital"
          specialty: null, // LocationIQ's Nearby API doesn't expose this tag directly
          phone: null, // not available via this endpoint
          address: [addr.house_number, addr.road, addr.city || addr.suburb]
            .filter(Boolean)
            .join(", ") || place.display_name || null,
          website: null,
          openingHours: null,
          lat: place.lat || null,
          lon: place.lon || null,
        };
      })
      .filter(Boolean);

    // Optional: filter loosely by specialty text if the user picked one
    // and it happens to appear in the place's name (best-effort only,
    // since this data source doesn't tag specialties explicitly).
    if (specialty && specialty.toLowerCase() !== "general physician") {
      const term = specialty.toLowerCase();
      const filtered = results.filter((r) => r.name.toLowerCase().includes(term));
      if (filtered.length > 0) results = filtered;
    }

    return new Response(
      JSON.stringify({
        city: geoData[0].display_name,
        count: results.length,
        results: results.slice(0, 25),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Something went wrong on our end. Please try again." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

// netlify/functions/find-doctors.js
//
// This is a serverless function. It runs on Netlify's servers, not in the
// browser — that's important because it lets us safely call external APIs
// without exposing any keys (and in this case, no key is needed at all).
//
// It does two things:
// 1. Asks OpenStreetMap's Nominatim service "where is this city?"
// 2. Asks Overpass API "what clinics/hospitals/doctors exist near there?"
//
// Both of these are free, public services with no API key and no signup.

export default async (req) => {
  try {
    const url = new URL(req.url);
    const city = url.searchParams.get("city");
    const specialty = url.searchParams.get("specialty") || "";

    if (!city || city.trim().length < 2) {
      return new Response(
        JSON.stringify({ error: "Please provide a city name." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 1: turn the city name into coordinates using Nominatim.
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(city)}`,
      {
        headers: {
          // Nominatim's usage policy requires a descriptive User-Agent.
          "User-Agent": "TahaDoc-Website/1.0 (contact: hello@tahadoc.com)",
        },
      }
    );

    if (!geoRes.ok) {
      return new Response(
        JSON.stringify({ error: "Could not look up that city right now. Please try again shortly." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const geoData = await geoRes.json();

    if (!geoData || geoData.length === 0) {
      return new Response(
        JSON.stringify({ error: `We couldn't find a city called "${city}". Try checking the spelling.` }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const lat = parseFloat(geoData[0].lat);
    const lon = parseFloat(geoData[0].lon);

    // Step 2: search Overpass API for medical places within ~6km of that point.
    const radiusMeters = 6000;
    const overpassQuery = `
      [out:json][timeout:25];
      (
        node["amenity"="clinic"](around:${radiusMeters},${lat},${lon});
        node["amenity"="doctors"](around:${radiusMeters},${lat},${lon});
        node["amenity"="hospital"](around:${radiusMeters},${lat},${lon});
        way["amenity"="clinic"](around:${radiusMeters},${lat},${lon});
        way["amenity"="doctors"](around:${radiusMeters},${lat},${lon});
        way["amenity"="hospital"](around:${radiusMeters},${lat},${lon});
      );
      out center 30;
    `;

    // Using the Private.coffee Overpass mirror instead of the official
    // overpass-api.de — the official instance has been rejecting requests
    // from cloud hosting providers (like Netlify) due to high load from
    // other users. This mirror is free, unlimited, and registration-free.
    const overpassRes = await fetch("https://overpass.private.coffee/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: overpassQuery,
    });

    if (!overpassRes.ok) {
      return new Response(
        JSON.stringify({ error: "The doctor directory is busy right now. Please try again in a moment." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const overpassData = await overpassRes.json();

    // Step 3: shape the raw OSM data into something clean for the frontend.
    let results = (overpassData.elements || [])
      .map((el) => {
        const tags = el.tags || {};
        const name = tags.name || tags["name:en"];
        if (!name) return null; // skip unnamed entries, not useful to show

        return {
          name,
          type: tags.amenity, // "clinic", "doctors", or "hospital"
          specialty: tags["healthcare:speciality"] || tags.speciality || null,
          phone: tags.phone || tags["contact:phone"] || null,
          address: [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"]]
            .filter(Boolean)
            .join(", ") || null,
          website: tags.website || tags["contact:website"] || null,
          openingHours: tags.opening_hours || null,
          lat: el.lat || (el.center && el.center.lat) || null,
          lon: el.lon || (el.center && el.center.lon) || null,
        };
      })
      .filter(Boolean);

    // Optional: filter loosely by specialty text if the user picked one.
    if (specialty && specialty.toLowerCase() !== "general physician") {
      const term = specialty.toLowerCase();
      const filtered = results.filter(
        (r) => (r.specialty && r.specialty.toLowerCase().includes(term)) ||
               r.name.toLowerCase().includes(term)
      );
      // Only apply the filter if it doesn't wipe out every result —
      // OSM's specialty tagging is inconsistent, so an empty filtered
      // list usually means "no tag data," not "no doctors."
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

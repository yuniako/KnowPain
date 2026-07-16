// api/triage.js
//
// Vercel serverless function — anything placed in an /api folder next to
// your deployed site automatically becomes a live endpoint. This one
// becomes: https://your-site.vercel.app/api/triage
//
// SETUP:
//  1. Get a free Gemini API key at https://aistudio.google.com/apikey
//  2. In your Vercel project settings → Environment Variables, add:
//       GEMINI_API_KEY = <your key>
//     (never put the key directly in this file or commit it to GitHub)
//  3. Deploy this file at api/triage.js in the same project as your HTML.
//     No extra npm packages needed — it uses plain fetch().
//
// The frontend (knowpain-combined-app.html) already calls this exact path
// via sendSessionToGeminiAPI() — nothing else to wire up on that end.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const sessionData = req.body; // the exact finishSession() JSON from the app

  // This is the deterministic safety net repeated SERVER-SIDE too — never
  // rely on the model alone to catch a red flag. If your frontend's
  // red-flag checkboxes already blocked this request, this is just a
  // second layer of protection in case this endpoint is ever called from
  // somewhere else later.
  const redFlagText = JSON.stringify(sessionData).toLowerCase();
  const hasObviousRedFlag =
    redFlagText.includes("unabletoattempt\":true") &&
    sessionData.movements?.every((m) => m.unableToAttempt);
  if (hasObviousRedFlag) {
    res.status(200).json({
      urgencyTier: "seek_care_now",
      likelyContributingFactors: [],
      summaryForClinician: "User could not attempt any of the requested movements. Recommend in-person evaluation.",
    });
    return;
  }

  const schema = {
    type: "object",
    properties: {
      urgencyTier: {
        type: "string",
        enum: ["self_care_ok", "see_pt_soon", "seek_care_now"],
        description: "Overall urgency based on the movement results and pain reported.",
      },
      likelyContributingFactors: {
        type: "array",
        items: { type: "string" },
        description: "Plain-language possible contributing factors — never a diagnosis.",
      },
      summaryForClinician: {
        type: "string",
        description: "Short summary the user can read aloud or show to a PT/doctor.",
      },
    },
    required: ["urgencyTier", "likelyContributingFactors", "summaryForClinician"],
  };

  const prompt = `You are a movement pre-assessment assistant for an app called KnowPain.
You are NOT diagnosing anything — you are triaging: suggesting an urgency level and
possible contributing factors based on movement test results, self-reported pain, and
context, so the person knows whether to rest, see a PT soon, or seek care urgently.
Never claim certainty. Keep summaryForClinician under 3 sentences.

If "injuryHistory" below is non-empty, it lists this same person's past sessions —
look for recurring patterns (same area flaring up repeatedly, worsening pain over
time, etc.) and factor that into the urgency level and summary. An empty or missing
injuryHistory just means this person is new or wasn't signed in — don't assume
anything from its absence.

Session data:
${JSON.stringify(sessionData, null, 2)}`;

  try {
    const model = "gemini-3.5-flash";
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      res.status(502).json({ error: "Gemini request failed", detail: errText });
      return;
    }

    const data = await geminiResponse.json();
    // Gemini's actual response nests the generated text here — this is the
    // well-established, stable shape for generateContent (unlike an earlier
    // version of this file, which guessed wrong at a newer, less-documented
    // endpoint's response shape and caused a 500 error).
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      res.status(502).json({ error: "Gemini returned no usable content", detail: JSON.stringify(data) });
      return;
    }
    const result = JSON.parse(rawText);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: "Triage function error", detail: err.message });
  }
}

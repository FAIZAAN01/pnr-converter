// api/report.js

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // --- Guard: check env var is actually loaded ---
    if (!process.env.MAIL_KEY) {
        console.error("MAIL_KEY is not set in environment variables");
        return res.status(500).json({ success: false, message: 'Server misconfiguration: MAIL_KEY missing' });
    }

    const { val, userIP, pnrData } = req.body;

    if (!val || !pnrData) {
        return res.status(400).json({ success: false, error: 'Missing required fields: val or pnrData' });
    }

    try {
        const payload = {
            access_key: process.env.MAIL_KEY,
            name: "System Reporter",
            email: "reporter@pnrconverter.vercel.app",
            subject: `Override: ${val} (IP: ${userIP || 'Unknown'})`,
            message: `User (IP: ${userIP || 'Unknown'}) corrected class to: ${val}\n\n--- PNR DATA ---\n${pnrData}`
        };

        console.log("Sending to Web3Forms, subject:", payload.subject);

        const response = await fetch("https://api.web3forms.com/submit", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(payload)
        });

        // Log the raw response status before trying to parse it
        console.log("Web3Forms response status:", response.status);

        const json = await response.json();
        console.log("Web3Forms response body:", JSON.stringify(json));

        if (!json.success) {
            return res.status(500).json({ success: false, message: json.message || 'Web3Forms rejected the submission' });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        // Log the full error so it appears in Vercel function logs
        console.error("Report handler threw:", error.name, error.message, error.stack);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
}
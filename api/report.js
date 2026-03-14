// api/report.js
// Vercel serverless function — keeps MAIL_KEY off the client entirely.

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { val, userIP, pnrData } = req.body;

    if (!val || !pnrData) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const response = await fetch("https://api.web3forms.com/submit", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                access_key: process.env.MAIL_KEY,
                name: "System Reporter",
                email: "reporter@pnrconverter.vercel.app",
                subject: `Override: ${val} (IP: ${userIP || 'Unknown'})`,
                message: `User (IP: ${userIP || 'Unknown'}) corrected class to: ${val}\n\n--- PNR DATA ---\n${pnrData}`
            })
        });

        const json = await response.json();

        if (!json.success) {
            console.error("Web3Forms error:", json.message);
            return res.status(500).json({ success: false, message: json.message });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Report handler error:", error);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
}
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const apiKey = process.env.IMGBB_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Server misconfiguration: IMGBB_API_KEY missing' });
        }

        const { image } = req.body; // Expecting base64 string from the client
        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }

        const formData = new URLSearchParams();
        formData.append('image', image);

        const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
            method: 'POST',
            body: formData,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const data = await imgbbRes.json();
        
        if (data && data.success) {
            return res.status(200).json({ url: data.data.url });
        } else {
            return res.status(500).json({ error: 'ImgBB upload failed', details: data });
        }
    } catch (error) {
        console.error("Upload error:", error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

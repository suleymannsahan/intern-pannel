const OLLAMA_URL = 'http://localhost:11434';

async function test() {
  console.log("Ollama'ya baglaniliyor, plan uretiliyor...\n");
  const prompt = `Sen bir proje planlama asistanisin. Asagidaki gorevi mantikli adimlara bol. Her adim icin tahmini gun belirt. Kisa, madde madde, Turkce yaz.

Gorev: Web sitesi giris sayfasi tasarimi
Aciklama: Kullanici giris ve kayit ekrani yapilacak
Toplam is gunu: 5
Son teslim: 2026-08-15`;
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5',
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });
    if (!response.ok) throw new Error('Ollama yanit vermedi. Calisiyor mu?');
    const data = await response.json();
    console.log("=== AI PLANI ===\n");
    console.log(data.message.content);
    console.log("\n=== TEST BASARILI ===");
  } catch (err) {
    console.log("HATA:", err.message);
  }
}
test();

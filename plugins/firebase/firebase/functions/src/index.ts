import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

admin.initializeApp();

export const getFirestoreData = functions.https.onRequest(
  async (req, res): Promise<void> => {
    // CORS 설정: 모든 출처 허용
    res.set("Access-Control-Allow-Origin", "*");

    try {
      const snapshot = await admin.firestore().collection("bundles").get();
      const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      res.status(200).json(data);
      return;
    } catch (error) {
      console.error("Error fetching data:", error);
      res.status(500).json({ error: "Failed to fetch data" });
      return;
    }
  },
);

import config from "../../config.js";

/**
 * Publisher provider interface:
 *   publish({ eventId, topic, key, payload }) => Promise<void>
 *
 * EVENT_PROVIDER=log       — writes events to stdout (default for local/hackathon demos)
 * EVENT_PROVIDER=kafka     — same interface, real Kafka once Aiven credentials exist
 */

const logProvider = {
  name: "log",
  async publish(event) {
    console.log(`[event] ${event.topic} key=${event.key ?? "-"} id=${event.eventId} ${JSON.stringify(event.payload)}`);
  },
};

let kafkaProducer = null;

const kafkaProvider = {
  name: "kafka",
  async publish(event) {
    if (!kafkaProducer) {
      // Imported lazily so the dependency is optional until Kafka is actually used.
      const { Kafka } = await import("kafkajs");
      const kafka = new Kafka({
        clientId: "shelfsync",
        brokers: (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean),
        ssl: config.databaseSsl || process.env.KAFKA_SSL === "true",
        sasl: process.env.KAFKA_SASL_USERNAME
          ? {
              mechanism: process.env.KAFKA_SASL_MECHANISM ?? "plain",
              username: process.env.KAFKA_SASL_USERNAME,
              password: process.env.KAFKA_SASL_PASSWORD,
            }
          : undefined,
      });
      kafkaProducer = kafka.producer();
      await kafkaProducer.connect();
    }
    await kafkaProducer.send({
      topic: event.topic,
      messages: [
        {
          key: event.key ?? null,
          value: JSON.stringify({ eventId: event.eventId, ...event.payload }),
        },
      ],
    });
  },
};

const providers = { log: logProvider, kafka: kafkaProvider };

export function getPublisher() {
  const provider = providers[config.eventProvider];
  if (!provider) throw new Error(`Unknown EVENT_PROVIDER "${config.eventProvider}" (expected log|kafka)`);
  return provider;
}

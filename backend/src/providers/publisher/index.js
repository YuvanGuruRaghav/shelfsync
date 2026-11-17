import config from "../../config.js";

/**
 * Publisher provider interface:
 *   publish({ eventId, topic, key, payload }) => Promise<void>
 *   subscribe(topic, groupId, handler) => Promise<void>
 *     where handler({ eventId, topic, key, payload }) => Promise<void>
 *
 * EVENT_PROVIDER=log       — logs events and dispatches in-process to subscribers
 * EVENT_PROVIDER=kafka     — same interface, real Kafka once Aiven credentials exist
 */

// --- log provider -----------------------------------------------------------

const logHandlers = new Map(); // topic -> Set<handler>

function handlersFor(topic) {
  if (!logHandlers.has(topic)) logHandlers.set(topic, new Set());
  return logHandlers.get(topic);
}

const logProvider = {
  name: "log",
  async publish(event) {
    console.log(`[event] ${event.topic} key=${event.key ?? "-"} id=${event.eventId} ${JSON.stringify(event.payload)}`);

    const envelope = {
      eventId: event.eventId,
      topic: event.topic,
      key: event.key,
      payload: event.payload,
    };
    await Promise.all(
      [...handlersFor(event.topic)].map(async (handler) => {
        try {
          await handler(envelope);
        } catch (err) {
          // A broken consumer must never take down the publisher.
          console.error(`[event] handler failed for topic ${event.topic} (id=${event.eventId})`, err);
        }
      }),
    );
  },
  async subscribe(topic, _groupId, handler) {
    handlersFor(topic).add(handler);
  },
};

// --- kafka provider ---------------------------------------------------------

let kafkaClient = null;
let kafkaProducer = null;

async function getKafkaClient() {
  if (!kafkaClient) {
    // Imported lazily so the dependency is optional until Kafka is actually used.
    const { Kafka } = await import("kafkajs");
    kafkaClient = new Kafka({
      clientId: "shelfsync",
      brokers: config.kafkaBrokers,
      ssl: config.kafkaSsl,
      sasl: config.kafkaSaslUsername
        ? {
            mechanism: config.kafkaSaslMechanism,
            username: config.kafkaSaslUsername,
            password: config.kafkaSaslPassword,
          }
        : undefined,
    });
  }
  return kafkaClient;
}

const kafkaProvider = {
  name: "kafka",
  async publish(event) {
    if (!kafkaProducer) {
      const kafka = await getKafkaClient();
      kafkaProducer = kafka.producer();
      await kafkaProducer.connect();
    }
    await kafkaProducer.send({
      topic: event.topic,
      messages: [
        {
          key: event.key ?? null,
          value: JSON.stringify(event.payload),
          headers: { eventId: event.eventId },
        },
      ],
    });
  },
  async subscribe(topic, groupId, handler) {
    const kafka = await getKafkaClient();
    const consumer = kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        await handler({
          eventId: message.headers?.eventId?.toString() ?? null,
          topic,
          key: message.key?.toString() ?? null,
          payload: JSON.parse(message.value.toString()),
        });
      },
    });
  },
};

const providers = { log: logProvider, kafka: kafkaProvider };

export function getPublisher() {
  const provider = providers[config.eventProvider];
  if (!provider) throw new Error(`Unknown EVENT_PROVIDER "${config.eventProvider}" (expected log|kafka)`);
  return provider;
}

import express, { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import {
  CoreAssistantMessage,
  CoreMessage,
  CoreSystemMessage,
  CoreToolMessage,
  CoreUserMessage,
  generateText,
  LanguageModelV1,
  ToolSet,
  UIMessage,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import {
  createGoogleGenerativeAI,
  GoogleGenerativeAIProviderOptions,
} from '@ai-sdk/google';
import { experimental_createMCPClient as createMcpClient } from 'ai';
import { getConversation, upsertConversation } from './db';
import multer from 'multer';

dotenv.config();
const PORT = process.env.PORT;
const llmModel = process.env.LLM_MODEL;
const apiKey = process.env.API_KEY;
const connectionString = process.env.CONNECTION_STRING;

if (!PORT || !apiKey || !llmModel || !connectionString) {
  throw new Error(
    `Env is not set. PORT:${!!PORT} apiKey:${apiKey} llmModel:${!!llmModel} connectionString:${connectionString}`
  );
}

const upload = multer({ storage: multer.memoryStorage(), dest: 'uploads/' });

let model: LanguageModelV1;
let isGoogle = false;

if (llmModel.includes('gemini')) {
  const google = createGoogleGenerativeAI({ apiKey });
  model = google(llmModel);
  isGoogle = true;
} else {
  const openai = createOpenAI({ apiKey });
  model = openai(llmModel);
}

const generateTextWrapper = async (
  messages:
    | Array<
        | CoreSystemMessage
        | CoreUserMessage
        | CoreAssistantMessage
        | CoreToolMessage
      >
    | Array<UIMessage>,
  tools?: ToolSet
) => {
  if (isGoogle) {
    return await generateText({
      model,
      messages: messages,
      tools: tools,
      maxSteps: tools ? 10 : 1,
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        } satisfies GoogleGenerativeAIProviderOptions,
      },
    });
  } else {
    return await generateText({
      model,
      messages: messages,
      tools: tools,
    });
  }
};

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log('start request', req.headers['x-chat-id'], req.body);
  res.on('close', () => {
    console.log('finish request', req.headers['x-chat-id'], req.body);
  });
  next();
});

app.post('/db', async (req: Request, res: Response, _next: NextFunction) => {
  const requestChatId = req.headers['x-chat-id'] as string;
  const message = req.body?.message as string;

  let messages: CoreMessage[] = [];

  const history = requestChatId
    ? await getConversation(requestChatId)
    : undefined;

  if (history) {
    messages.push(...history.messages);
  }

  const prompt = `あなたは優秀なPostgresのエンジニアです。
ユーザーからの要望に応えられるようにツールを呼び出して回答をしてください。

重要！！
1. SQLを実行した場合は、応答にそのSQLを絶対に含めてください
2. いきなりSQL実行ではなく、テーブルのリレーションやテーブル定義を取得してから実施してください。
`;

  if (!messages.length) {
    messages.push({ role: 'system', content: prompt });
  }

  messages.push({ role: 'user', content: message });

  const postgresMcpClient = await createMcpClient({
    transport: {
      type: 'sse',
      url: 'http://localhost:8009/sse',
    },
  });

  const posgreTools = await postgresMcpClient.tools();

  const text = await generateTextWrapper(messages, posgreTools);

  //   console.log('text.response');

  const responseMessages = text.response.messages.map((msg) => ({
    role: msg.role,
    content: JSON.stringify(msg.content),
  })) as CoreMessage[];

  const id = await upsertConversation(history?.id, [
    ...messages,
    ...responseMessages,
  ]);

  console.log(text.text);

  res.setHeader('x-chat-id', id).json({ text: text });
});

app.post('/figma', async (req: Request, res: Response, _next: NextFunction) => {
  const requestChatId = req.headers['x-chat-id'] as string;
  const fileKey = req.body?.fileKey as string;
  const nodeId = req.body?.nodeId as string;

  const figmaMcpClient = await createMcpClient({
    transport: {
      type: 'sse',
      url: 'http://localhost:3333/sse',
    },
  });

  const shadcnMcpClient = await createMcpClient({
    transport: {
      type: 'sse',
      url: 'http://localhost:8888/sse',
    },
  });
  const figma = await figmaMcpClient.tools();
  const shadcn = await shadcnMcpClient.tools();

  const prompt = `あなたは優秀なReactエンジニアです。

Figmaのデータを元にshadcn-uiを使ってReactで画面やコンポーネントを作成してください。
また、CSSはtailwindを使ってください。

Figmaの情報を取得できるツールとshadcn-uiの情報を取得できるツールを用意しているので、活用して進めてください。

# 重要！！
以下を順に実施してください。
1. 最初にFigmaのデザインをfileKey: "${fileKey}"とnodeId: "${nodeId}"を使って取得してください。depthは設定しないこと！！
2. shadcn-uiの一覧を取得できるツールは絶対に使用してください。
3. 1と2の情報を元に使用するshadcn-uiのコンポーネントの情報を取得
4. 画面の生成を実施。なお、TypeScriptで作成してください。
5. ** Reactの画面やコンポーネントができるまで繰り返してください！！ **

### コード作成時の注意事項
コードの中でshadcn-uiのコンポーネントを呼び出す際は以下のように使用してください。

import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
`;

  const text = await generateTextWrapper([{ role: 'user', content: prompt }], {
    ...figma,
    ...shadcn,
  });

  await figmaMcpClient.close();
  await shadcnMcpClient.close();

  console.log(text.text);

  res.json({ text: text.text });
});

app.post(
  '/image',
  upload.single('image'),
  async (req: Request, res: Response, _next: NextFunction) => {
    const { file } = req;

    if (!file) {
      res.status(400).send('file is not set');
      return;
    }

    const shadcnMcpClient = await createMcpClient({
      transport: {
        type: 'sse',
        url: 'http://localhost:8888/sse',
      },
    });

    const shadcn = await shadcnMcpClient.tools();

    const prompt = `あなたは優秀なReactエンジニアです。

画像を元にshadcn-uiを使ってReactで画面やコンポーネントを作成してください。
また、CSSはtailwindを使ってください。

shadcn-uiの情報を取得できるツールを用意しているので、活用して進めてください。

# 重要！！
以下を順に実施してください。
1. shadcn-uiの一覧を取得できるツールは絶対に使用してください。
2. 1と画像を元に使用するshadcn-uiのコンポーネントの情報を取得
4. 画面の生成を実施。なお、TypeScriptで作成してください。
5. ** Reactの画面やコンポーネントができるまで繰り返してください！！ **

### コード作成時の注意事項
コードの中でshadcn-uiのコンポーネントを呼び出す際は以下のように使用してください。

import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
`;

    const text = await generateTextWrapper(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', image: file.buffer },
          ],
        },
      ],
      {
        ...shadcn,
      }
    );

    await shadcnMcpClient.close();

    console.log(text.text);

    res.json({ text: text.text });
  }
);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

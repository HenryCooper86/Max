# Documentation

## Build with it

| Guide                                         | Read it when                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| [Getting started](getting-started.md)         | You are new: from clone to a voice agent in your app, then production          |
| [Web SDK](../sdk/README.md)                   | You are adding the agent to a web page or a React app                          |
| [Troubleshooting the SDK](troubleshooting.md) | The widget or SDK fails: HTTPS, microphone, blocked origins, close codes, iOS  |
| [Tools](tools.md)                             | The agent should read your data or take actions                                |
| [Running a conversation](conversations.md)    | You want check-ins, handoff between agents, resume, memory, analysis or traces |
| [Phone calls](telephony.md)                   | You want people to phone the assistant, or the assistant to phone them         |
| [Testing your agent](testing-agents.md)       | You want scripted or simulated conversations to check prompts, tools and flows |
| [Configuration](configuration.md)             | You are shaping the assistant or setting environment variables                 |
| [Voice backends](backends.md)                 | You are choosing a model, or adding your own backend                           |
| [Protocol](protocol.md)                       | You are writing a client in another language, an app or a device               |
| [Security](security.md)                       | Before you put the relay on the internet                                       |
| [Deployment](deployment.md)                   | You are running it in production: Docker, TLS, scaling                         |
| [Usage and billing](usage-and-billing.md)     | You want to cap or bill your users' voice minutes                              |
| [Pricing and licensing](pricing.md)           | You want to know what is free and what Max Cloud and Enterprise add            |
| [How Max compares](comparison.md)             | You are choosing between Max and a hosted agent platform or another framework  |
| [Running Max Cloud](cloud.md)                 | You run the hosted service: accounts, projects, top-ups, WeChat Pay and Alipay |

## Devices and audio

| Guide                                              | Read it when                                                 |
| -------------------------------------------------- | ------------------------------------------------------------ |
| [Hardware and audio](audio/README.md)              | You are putting the agent on your own microphone and speaker |
| [Running locally](local-models.md)                 | You want open-weight models on your own machine, offline     |
| [Python device client](../examples/device-client/) | You want a working reference client for a Linux device       |

## The reference assistant

[Max helmet](max-helmet.md) documents the motorcycle-helmet assistant the kit grew out of: its iOS, Android and
embedded clients, navigation, camera, hazard alerts, and the QA framework used to release it. Its design notes are in
[superpowers/](superpowers/).

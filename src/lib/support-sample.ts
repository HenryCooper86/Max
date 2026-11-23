/** The scripted order lookup shown in Studio and on the public site. */
export const SUPPORT_SAMPLE = {
  question: { zh: "能帮我查一下订单 A-1042 到哪了吗？", en: "Where is my order A-1042?" },
  tool: {
    call: 'check_order({ "orderId": "A-1042" })',
    result: { zh: "已发货 · 预计周五送达", en: "Shipped · Estimated delivery Friday" }
  },
  reply: { zh: "您的包裹已发出，预计周五送达。", en: "Your package has shipped and should arrive on Friday." }
};

const nouns={fridge:'Geladeira',shelf:'Prateleira',slot:'Posição'};
const collections={fridge:'fridges',shelf:'shelves',slot:'slots'};
const safeError=e=>typeof e?.message==='string'?e.message:'Não foi possível concluir a solicitação.';
const percent=ratio=>Math.round(Number(ratio)*10000)/100;
export function fridgeSlotState({quantity,min_quantity,target_quantity}){
  const current=Number(quantity);
  return current===0?'VAZIO':current<Number(min_quantity)?'CRÍTICO':current<Number(target_quantity)?'ATENÇÃO':'OK';
}
const physicalOrder=(axis)=>(a,b)=>Number(a[axis])-Number(b[axis])||a.sort_order-b.sort_order||a.id.localeCompare(b.id);
export function fridgeReplenishmentRows(data,today){
  const f=new Map(data.fridges.filter(x=>x.active).map(x=>[x.id,x]));
  const h=new Map(data.shelves.filter(x=>x.active&&f.has(x.fridge_id)).map(x=>[x.id,x]));
  const dry=new Map();
  for(const lot of data.dry)if(lot.expiry>=today&&lot.product_active&&lot.quantity>0)
    dry.set(lot.product_id,(dry.get(lot.product_id)||0)+Number(lot.quantity));
  const rows=data.slots.filter(x=>x.active&&x.product_active&&x.product_id&&f.has(x.fridge_id)&&h.has(x.shelf_id))
    .map(slot=>({slot,fridge:f.get(slot.fridge_id),shelf:h.get(slot.shelf_id),
      demand:Math.max(0,Math.min(slot.target_quantity,slot.capacity_quantity)-Number(slot.quantity))}))
    .filter(x=>x.demand>0)
    .sort((a,b)=>{
      const priority={VAZIO:0,'CRÍTICO':1,'ATENÇÃO':2,OK:3};
      return priority[fridgeSlotState(a.slot)]-priority[fridgeSlotState(b.slot)]||
        a.fridge.sort_order-b.fridge.sort_order||a.shelf.sort_order-b.shelf.sort_order||
        a.slot.sort_order-b.slot.sort_order||a.slot.id.localeCompare(b.slot.id);
    });
  const remaining=new Map(dry);
  for(const row of rows){
    const available=remaining.get(row.slot.product_id)||0;
    row.estimated=Math.min(row.demand,available);
    remaining.set(row.slot.product_id,available-row.estimated);
  }
  return rows;
}

export function createFridgesUI({getContext,refreshStock}){
  const el=id=>document.getElementById(id);
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const owner=()=>getContext().shop?.role==='owner';
  const view=()=>location.hash==='#geladeiras';
  const msg=text=>{el('fridgeMessage').textContent=text;};
  let data=null, editing=false, restocking=false, busy=false, generation=0, pendingRefresh=false;
  let photoUrls=new Map();
  let allocationRetry=null;
  let replenishSlot=null, replenishQuote=null, replenishRetry=null;
  let stockQuote=null, stockRetry=null;
  const kind=()=>el('fridgeEditKind').value;
  const selected=()=>data?.[collections[kind()]]?.find(row=>row.id===el('fridgeEditItem').value);
  const option=(value,label)=>{const o=node('option',label);o.value=value;return o;};
  function sync(){
    if(!owner())editing=false;
    const locked=busy||!navigator.onLine;
    el('fridgeEdit').classList.toggle('hidden',!owner());
    el('fridgeEdit').disabled=locked||!data;
    el('fridgeAllocate').classList.toggle('hidden',!owner());
    el('fridgeAllocate').disabled=locked||!data?.unallocated.some(l=>l.quantity>0);
    el('fridgeOperateStock').disabled=locked||!data;
    el('fridgeOperate').setAttribute('aria-pressed',String(!editing&&!restocking));
    el('fridgeRestockMode').setAttribute('aria-pressed',String(restocking));
    el('fridgeEdit').setAttribute('aria-pressed',String(editing));
    el('fridgeEditor').classList.toggle('hidden',!editing);
    el('fridgeMap').classList.toggle('hidden',editing||restocking);
    el('fridgeRestockView').classList.toggle('hidden',!restocking);
    el('fridgeOffline').classList.toggle('hidden',navigator.onLine);
    el('fridgeReload').disabled=locked;
    el('fridgeLayoutFields').disabled=locked;
    el('fridgeSaveLayout').disabled=locked||!editing||!data;
    el('fridgeEditKind').disabled=locked;
    el('fridgeEditItem').disabled=locked;
    const allocating=el('fridgeAllocationDialog').open;
    if(allocating){
      el('fridgeAllocationLot').disabled=locked;
      for(const input of el('fridgeAllocationDestinations').querySelectorAll('input'))input.disabled=locked;
      el('fridgeCancelAllocation').disabled=busy;
      allocationSummary();
    }
    for(const root of ['fridgeMap','fridgeRestockList'])
      for(const action of el(root).querySelectorAll('[data-replenish]'))action.disabled=locked;
    if(el('fridgeReplenishDialog').open)syncReplenish();
    if(el('fridgeStockDialog').open)syncStock();
  }
  function field(name,label,settings={}){
    const wrapper=node('div');wrapper.className='field';
    const input=node(settings.options?'select':'input');
    input.id='fridgeField_'+name;input.name=name;
    const caption=node('label',label);caption.htmlFor=input.id;
    if(settings.options)input.replaceChildren(...settings.options.map(([id,text])=>option(id,text)));
    else{
      input.type=settings.type||'text';
      if(settings.maxLength)input.maxLength=settings.maxLength;
      for(const prop of ['min','max','step'])if(settings[prop]!==undefined)input[prop]=settings[prop];
    }
    if(input.type==='checkbox')input.checked=settings.value!==false;
    else input.value=settings.value??'';
    input.required=settings.required===true;
    wrapper.append(caption,input);el('fridgeLayoutFields').append(wrapper);
    return input;
  }
  function renderForm(){
    const fields=el('fridgeLayoutFields');fields.replaceChildren();
    const item=selected(),type=kind();
    if(!data)return;
    field('name','Nome',{value:item?.name,maxLength:120,required:true});
    field('active','Ativa',{type:'checkbox',value:item?.active});
    field('sort_order','Ordem',{type:'number',value:item?.sort_order??0,min:0,max:10000,step:1,required:true});
    if(type==='fridge')field('width_ratio','Largura visual (%)',{type:'number',value:percent(item?.width_ratio??1),min:25,max:100,step:.01,required:true});
    if(type==='shelf'||type==='slot'){
      if(!item){
        const f=field('fridge_id','Geladeira',{options:[['','Selecione'],...data.fridges.map(x=>[x.id,x.name])],required:true});
        if(type==='slot'){
          const h=field('shelf_id','Prateleira',{options:[['','Selecione']],required:true});
          f.addEventListener('change',()=>h.replaceChildren(option('','Selecione'),...data.shelves.filter(x=>x.fridge_id===f.value).map(x=>option(x.id,x.name))));
        }
      }else{
        const f=data.fridges.find(x=>x.id===item.fridge_id), h=data.shelves.find(x=>x.id===item.shelf_id);
        fields.append(node('p',[f?.name,h?.name].filter(Boolean).join(' / ')));
      }
      if(type==='shelf'){
        field('y_ratio','Posição vertical (%)',{type:'number',value:percent(item?.y_ratio??0),min:0,max:95,step:.01,required:true});
        field('height_ratio','Altura relativa (%)',{type:'number',value:percent(item?.height_ratio??1),min:5,max:100,step:.01,required:true});
      }else{
        field('x_ratio','Posição horizontal (%)',{type:'number',value:percent(item?.x_ratio??0),min:0,max:95,step:.01,required:true});
        field('width_ratio','Largura relativa (%)',{type:'number',value:percent(item?.width_ratio??1),min:5,max:100,step:.01,required:true});
        const products=(getContext().products||[]).filter(p=>p.active||p.id===item?.product_id);
        field('product_id','Produto associado',{options:[['','Sem associação'],...products.map(p=>[p.id,p.name+(p.active?'':' (inativo)')])],value:item?.product_id});
        for(const [key,label,value,min] of [['min_quantity','Mínimo',0,0],['target_quantity','Meta',0,0],['capacity_quantity','Capacidade',24,1]]){
          field(key,label,{type:'number',value:item?.[key]??value,min,max:1000000,step:1,required:true});
        }
      }
    }
  }
  function renderEditor(id=''){
    const type=kind();
    const items=data?.[collections[type]]||[];
    const label=item=>{
      const parents=[data.fridges.find(f=>f.id===item.fridge_id)?.name,data.shelves.find(h=>h.id===item.shelf_id)?.name];
      return [...parents.filter(Boolean),item.name+(item.active?'':' (inativa)')].join(' / ');
    };
    el('fridgeEditItem').replaceChildren(option('','Criar: '+nouns[type]),...items.map(item=>option(item.id,label(item))));
    el('fridgeEditItem').value=items.some(i=>i.id===id)?id:'';
    renderForm();
  }
  function renderMap(){
    const map=el('fridgeMap');map.replaceChildren();
    if(!data)return;
    const enabled=data.fridges.filter(f=>f.active);
    if(!enabled.length)map.append(node('p','Nenhuma geladeira ativa. O saldo legado permanece não alocado.'));
    const cabinets=node('div');cabinets.className='fridge-cabinets';
    for(const f of enabled){
      const block=node('section');block.className='fridge-cabinet';
      block.style.setProperty('--cabinet-width',percent(f.width_ratio)*.48+'%');
      const title=node('h3',f.name);title.id='fridge-cabinet-'+f.id;
      block.setAttribute('aria-labelledby',title.id);
      block.append(title,node('p','Ativa'));
      const shelves=data.shelves.filter(h=>h.active&&h.fridge_id===f.id).sort(physicalOrder('y_ratio'));
      if(!shelves.length)block.append(node('p','Sem prateleiras ativas.'));
      for(const h of shelves){
        const shelf=node('section');shelf.className='fridge-shelf';
        const shelfTitle=node('h4',h.name);shelfTitle.id='fridge-shelf-'+h.id;
        shelf.setAttribute('aria-labelledby',shelfTitle.id);
        shelf.append(shelfTitle);
        const rail=node('div');rail.className='fridge-rail';rail.style.setProperty('--shelf-size',String(h.height_ratio));
        const slots=data.slots.filter(x=>x.active&&x.shelf_id===h.id).sort(physicalOrder('x_ratio'));
        if(!slots.length)shelf.append(node('p','Sem posições ativas.'));
        const laneEnds=[];
        for(const x of slots){
          const start=Math.min(100,Math.floor(percent(x.x_ratio))+1);
          const end=Math.max(start+1,Math.min(101,Math.ceil(percent(Number(x.x_ratio)+Number(x.width_ratio)))+1));
          let lane=laneEnds.findIndex(e=>e<=start);
          if(lane<0)lane=laneEnds.length;
          laneEnds[lane]=end;
          const card=node('article');card.className='fridge-slot';card.dataset.slotId=x.id;
          card.style.setProperty('--slot-column',start+' / '+end);card.style.setProperty('--slot-row',String(lane+1));
          const name=node('h5',x.name);name.id='fridge-slot-'+x.id;card.setAttribute('aria-labelledby',name.id);
          const types=[...new Set(x.lots.map(l=>l.product_name))];
          const label=x.product_name||types.join(', ')||'Sem produto associado';
          const image=photoUrls.get(x.image_path||(types.length===1?x.lots[0]?.image_path:null));
          const placeholder=()=>{const n=node('span','▧');n.className='fridge-photo fridge-photo-fallback';n.setAttribute('aria-hidden','true');return n;};
          if(image){const img=node('img');img.className='fridge-photo';img.src=image;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.replaceWith(placeholder()),{once:true});card.append(img);}
          else card.append(placeholder());
          const state=fridgeSlotState(x),badge=node('span',state);badge.className='fridge-state';badge.dataset.state=state;
          const meter=node('meter');meter.min=0;meter.max=x.capacity_quantity;meter.value=x.quantity;
          meter.setAttribute('aria-label','Ocupação de '+x.name);meter.textContent=x.quantity+' de '+x.capacity_quantity;
          card.append(name,node('p',label+(x.product_active===false?' (inativo)':'')),node('p',x.quantity+' / '+x.capacity_quantity+' un.'),
            meter,badge,node('p','Mínimo '+x.min_quantity+' · Meta '+x.target_quantity));
          if(x.product_id&&x.product_active){
            const replenish=node('button','Repor');replenish.className='btn';replenish.type='button';replenish.dataset.replenish=x.id;
            replenish.setAttribute('aria-label','Repor '+x.name);
            replenish.disabled=busy||!navigator.onLine;
            replenish.addEventListener('click',()=>openReplenish(x,f,h));
            card.append(replenish);
          }
          if(x.lots.length){
            const lots=node('details');lots.append(node('summary','Lotes e validade'));
            const rows=node('ul');
            for(const l of x.lots)rows.append(node('li',l.code+' · '+l.quantity+' un. · '+l.expiry.split('-').reverse().join('/')));
            lots.append(rows);card.append(lots);
          }
          rail.append(card);
        }
        shelf.append(rail);block.append(shelf);
      }
      cabinets.append(block);
    }
    const unallocated=node('section');unallocated.className='fridge-unallocated';
    unallocated.append(node('h3','Geladeira — não alocado'),node('p',data.unallocated.reduce((sum,l)=>sum+Number(l.quantity),0)+' un. sem posição física'));
    if(data.unallocated.length){
      const list=node('ul');
      for(const l of data.unallocated)list.append(node('li',l.product_name+' · '+l.code+' · '+l.quantity+' un. · '+l.expiry.split('-').reverse().join('/')));
      unallocated.append(list);
    }
    map.append(cabinets,unallocated);
  }
  async function loadPhotos(next,client,stamp){
    const paths=[...new Set(next.slots.flatMap(x=>[x.image_path,...x.lots.map(l=>l.image_path)]).filter(Boolean))];
    if(!paths.length||!client.storage||!client.supabaseUrl)return;
    try{
      const {data:signed}=await client.storage.from('guigs-product-images').createSignedUrls(paths,300);
      if(stamp!==generation||next!==data)return;
      const origin=new URL(client.supabaseUrl).origin;
      for(const entry of signed||[]){
        if(!entry.signedUrl||!paths.includes(entry.path))continue;
        const url=new URL(entry.signedUrl);
        if(url.origin===origin&&url.pathname.startsWith('/storage/v1/object/sign/guigs-product-images/'))photoUrls.set(entry.path,url.href);
      }
      if(photoUrls.size&&!editing)renderMap();
    }catch{/* Sem foto, conservar o placeholder e os dados de estoque. */}
  }
  function renderRestock(){
    const list=el('fridgeRestockList'), summary=el('fridgeRestockSummary');
    list.replaceChildren();summary.replaceChildren();
    if(!data)return;
    const rows=fridgeReplenishmentRows(data,new Date().toISOString().slice(0,10));
    const filter=el('fridgeRestockFilter').value;
    const visible=rows.filter(r=>filter==='all'||(filter==='available'?r.estimated>0:r.estimated<r.demand));
    const groups=new Map();
    for(const row of rows){
      const key=row.slot.product_id;
      const group=groups.get(key)||{name:row.slot.product_name,demand:0,estimated:0};
      group.demand+=row.demand;group.estimated+=row.estimated;groups.set(key,group);
    }
    if(groups.size){
      const totals=node('ul');
      for(const g of groups.values())totals.append(node('li',g.name+' · Pegar até '+g.estimated+' de '+g.demand+' un.'));
      summary.append(node('h3','Resumo por produto'),totals);
    }
    if(!visible.length)list.append(node('p',rows.length?'Nenhuma posição neste filtro.':'Todas as posições ativas com produto atingiram a meta.'));
    for(const row of visible){
      const {fridge,shelf,slot,estimated,demand}=row;
      const card=node('article');card.className='panel';card.dataset.restockSlot=slot.id;
      card.append(node('h3',slot.product_name+' · '+slot.name),node('p',fridge.name+' / '+shelf.name),
        node('p',slot.quantity+' / '+slot.capacity_quantity+' un. · Repor '+demand+' até a meta.'),
        node('p',estimated===0?'Sem estoque seco elegível para esta posição.':'Pegar até '+estimated+' un.'+(estimated<demand?' · Seco insuficiente para a meta.':'')));
      if(estimated>0){
        const button=node('button','Conferir reposição');button.type='button';button.className='btn';button.dataset.replenish=slot.id;
        button.addEventListener('click',()=>openReplenish(slot,fridge,shelf,estimated));
        card.append(button);
      }
      list.append(card);
    }
  }
  async function load({keepId=el('fridgeEditItem').value,announce=true}={}){
    const {client,shop}=getContext();
    if(!client||!shop||!navigator.onLine)return;
    if(busy){pendingRefresh=true;return;}
    const stamp=generation;busy=true;sync();if(announce)msg('Consultando mapa…');
    try{
      const {data:next,error}=await client.rpc('guigs_get_fridge_map',{p_shop_id:shop.shop_id});
      if(stamp!==generation)return;
      if(error)throw error;
      if(!next||Object.values(collections).concat('unallocated','dry').some(k=>!Array.isArray(next[k])))throw Error('Mapa indisponível nesta versão do banco.');
      data=next;photoUrls=new Map();renderMap();if(editing)renderEditor(keepId);if(restocking)renderRestock();
      void loadPhotos(next,client,stamp);
      if(announce)msg('');
    }catch(error){if(stamp===generation)msg(safeError(error));}
    finally{
      if(stamp===generation){
        busy=false;sync();
        if(pendingRefresh){pendingRefresh=false;if(view()&&navigator.onLine)void load({announce:false});}
      }
    }
  }
  const allocationMessage=text=>{el('fridgeAllocationMessage').textContent=text;};
  const stockMessage=text=>{el('fridgeStockMessage').textContent=text;};
  const stockKind=()=>el('fridgeStockKind').value;
  const stockSource=()=>el('fridgeStockOrigin').value;
  const stockSpec=()=>({kind:stockKind(),product_id:el('fridgeStockProduct').value||null,
    origin:['auto','unallocated'].includes(stockSource())?stockSource():'slot',
    slot_id:['auto','unallocated',''].includes(stockSource())?null:stockSource(),
    lot_id:stockKind()==='sale'?null:el('fridgeStockLot').value||null,
    quantity:Number(el('fridgeStockQuantity').value)});
  const stockPayload=()=>JSON.stringify(stockSpec());
  function syncStock(){
    const locked=busy||!navigator.onLine, permitted=stockKind()!=='adjust'||owner();
    el('fridgeStockFields').disabled=locked;
    el('fridgeStockCancel').disabled=busy;
    el('fridgeStockQuote').disabled=locked||!permitted;
    el('fridgeStockConfirm').disabled=locked||!permitted||!stockQuote||
      stockQuote.signature!==stockPayload()||!el('fridgeStockForm').checkValidity();
  }
  function stockLots(){
    const origin=stockSource(),product=el('fridgeStockProduct').value;
    const rows=origin==='unallocated'?data.unallocated:data.slots.find(s=>s.id===origin)?.lots||[];
    const labels=new Map(rows.filter(l=>l.product_id===product).map(l=>[l.lot_id,l.code+' · '+l.quantity+' un.']));
    if(stockKind()==='adjust'){
      for(const l of getContext().lots||[])if(l.product_id===product&&!labels.has(l.id))labels.set(l.id,l.code+' · 0 un.');
    }
    el('fridgeStockLot').replaceChildren(...[...labels].map(([id,label])=>option(id,label)));
    invalidateStock();
  }
  function stockOrigins(){
    const product=el('fridgeStockProduct').value, op=stockKind();
    const slots=data.slots.filter(s=>s.active&&data.fridges.some(f=>f.active&&f.id===s.fridge_id)&&data.shelves.some(h=>h.active&&h.id===s.shelf_id))
      .filter(s=>op==='adjust'?(!s.product_id||s.product_id===product):s.lots.some(l=>l.product_id===product&&l.quantity>0));
    const choices=slots.map(s=>[s.id,[data.fridges.find(f=>f.id===s.fridge_id)?.name,data.shelves.find(h=>h.id===s.shelf_id)?.name,s.name].filter(Boolean).join(' / ')]);
    if(op==='adjust'||data.unallocated.some(l=>l.product_id===product&&l.quantity>0))choices.push(['unallocated','Geladeira — não alocado']);
    if(op==='sale')choices.unshift(['auto','Automática (FEFO; pode dividir entre posições)']);
    el('fridgeStockOrigin').replaceChildren(...choices.map(([id,label])=>option(id,label)));
    stockLots();
  }
  function stockFields(){
    const op=stockKind();
    el('fridgeStockLotField').classList.toggle('hidden',op==='sale');
    el('fridgeStockLot').required=op!=='sale';
    el('fridgeStockQuantity').min=op==='adjust'?0:1;
    el('fridgeStockQuantityLabel').textContent=op==='adjust'?'Saldo final deste lote na posição':'Quantidade';
    el('fridgeStockNote').required=['adjust','loss'].includes(op);
    el('fridgeStockRule').textContent=op==='sale'
      ?'A sugestão usa primeiro o lote não vencido mais próximo do vencimento. Escolha uma origem para limitar a venda.'
      :op==='return'?'O retorno credita o estoque seco e debita exatamente a origem escolhida.':'O saldo será alterado somente na origem escolhida.';
    const present=new Set([...data.unallocated,...data.slots.flatMap(s=>s.lots)].filter(l=>l.quantity>0).map(l=>l.product_id));
    const products=(getContext().products||[]).filter(p=>op==='adjust'||(present.has(p.id)&&(op!=='sale'||p.active)));
    el('fridgeStockProduct').replaceChildren(...products.map(p=>option(p.id,p.name)));
    stockOrigins();
  }
  function invalidateStock(){
    stockQuote=null;el('fridgeStockPlan').replaceChildren();stockMessage('');syncStock();
  }
  el('fridgeOperateStock').addEventListener('click',()=>{
    if(!data||busy||!navigator.onLine)return;
    el('fridgeStockKind').replaceChildren(option('sale','Venda'),option('loss','Perda'),option('return','Retorno ao estoque seco'));
    if(owner())el('fridgeStockKind').append(option('adjust','Ajuste de saldo'));
    el('fridgeStockQuantity').value='';el('fridgeStockNote').value='';
    stockFields();el('fridgeStockDialog').showModal();syncStock();
  });
  el('fridgeStockKind').addEventListener('change',stockFields);
  el('fridgeStockProduct').addEventListener('change',stockOrigins);
  el('fridgeStockOrigin').addEventListener('change',stockLots);
  el('fridgeStockLot').addEventListener('change',invalidateStock);
  el('fridgeStockQuantity').addEventListener('input',invalidateStock);
  el('fridgeStockNote').addEventListener('input',syncStock);
  el('fridgeStockCancel').addEventListener('click',()=>{if(!busy)el('fridgeStockDialog').close();});
  el('fridgeStockDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  el('fridgeStockQuote').addEventListener('click',async()=>{
    if(busy||!navigator.onLine||!el('fridgeStockForm').reportValidity())return;
    const {client,shop}=getContext(),spec=stockSpec(),signature=stockPayload(),stamp=generation;
    if(!client||!shop)return;
    invalidateStock();busy=true;sync();stockMessage('Conferindo saldo e origem…');
    try{
      const {data:quote,error}=await client.rpc('guigs_get_fridge_operation',{p_shop_id:shop.shop_id,p_spec:spec});
      if(stamp!==generation)return;
      if(error)throw error;
      if(!quote?.plan?.length)throw Error('Plano indisponível.');
      stockQuote={signature,quote};
      el('fridgeStockPlan').replaceChildren(...quote.plan.map(l=>node('li',l.slot_label+' · '+l.code+' · '+l.current+' → '+(l.current+l.delta)+' un.')));
      stockMessage(quote.plan.length>1?'Confira a divisão entre origens antes de confirmar.':'Confira a origem e o novo saldo antes de confirmar.');
    }catch(error){if(stamp===generation)stockMessage(safeError(error));}
    finally{if(stamp===generation){busy=false;sync();}}
  });
  el('fridgeStockForm').addEventListener('submit',async e=>{
    e.preventDefault();
    if(!stockQuote||busy||!navigator.onLine||el('fridgeStockConfirm').disabled)return;
    const {client,shop}=getContext(),stamp=generation;
    const args={p_shop_id:shop.shop_id,p_spec:stockSpec(),p_expected:stockQuote.quote,p_note:el('fridgeStockNote').value.trim()};
    const signature=JSON.stringify(args);
    if(stockRetry?.signature!==signature)stockRetry={signature,request:crypto.randomUUID()};
    busy=true;sync();stockMessage('Confirmando movimentação…');
    let saved=false;
    try{
      const r=await client.rpc('guigs_apply_fridge_operation',{...args,p_request_id:stockRetry.request});
      if(r.error)throw r.error;
      if(!r.data?.event_id)throw Error('Resposta não confirmada. Tente novamente com os mesmos valores.');
      if(stamp!==generation)return;
      saved=true;stockRetry=null;stockQuote=null;el('fridgeStockDialog').close();
      msg('Movimentação registrada no histórico.');
    }catch(error){if(stamp===generation)stockMessage(safeError(error));}
    finally{if(stamp===generation){busy=false;sync();}}
    if(saved&&stamp===generation){await load({announce:false});if(refreshStock&&stamp===generation)await refreshStock();}
  });
  const replenishMessage=text=>{el('fridgeReplenishMessage').textContent=text;};
  function syncReplenish(){
    const locked=busy||!navigator.onLine;
    const quantity=el('fridgeReplenishQuantity');
    quantity.disabled=locked;
    el('fridgeReplenishQuote').disabled=locked;
    el('fridgeReplenishCancel').disabled=busy;
    el('fridgeReplenishConfirm').disabled=locked||!replenishQuote?.quantity||Number(quantity.value)!==replenishQuote.quantity;
  }
  function openReplenish(slot,fridge,shelf,preferred=null){
    if(busy||!navigator.onLine||!getContext().shop)return;
    replenishSlot=slot;replenishQuote=null;
    el('fridgeReplenishPosition').textContent=[fridge.name,shelf.name,slot.name].join(' / ');
    el('fridgeReplenishStats').textContent='';el('fridgeReplenishPlan').replaceChildren();
    el('fridgeReplenishQuantity').value='';
    el('fridgeReplenishDialog').showModal();void quoteReplenishment(preferred);
  }
  async function quoteReplenishment(quantity){
    if(busy||!navigator.onLine||!replenishSlot)return;
    const {client,shop}=getContext(),stamp=generation;
    if(!client||!shop)return;
    busy=true;replenishQuote=null;sync();replenishMessage('Calculando lotes…');
    try{
      const {data:quote,error}=await client.rpc('guigs_get_fridge_replenishment',{
        p_shop_id:shop.shop_id,p_slot_id:replenishSlot.id,p_quantity:quantity});
      if(stamp!==generation)return;
      if(error)throw error;
      if(!quote||!Array.isArray(quote.plan))throw Error('Sugestão indisponível.');
      replenishQuote=quote;
      el('fridgeReplenishQuantity').value=quote.quantity||'';
      el('fridgeReplenishStats').textContent=quote.product_name+' · Atual: '+quote.current+' / '+quote.capacity+' · Mínimo: '+quote.min+' · Meta: '+quote.target+' · Seco elegível: '+quote.dry_available;
      el('fridgeReplenishPlan').replaceChildren(...quote.plan.map(l=>node('li',l.code+' · '+l.quantity+' un. · '+l.expiry.split('-').reverse().join('/'))));
      replenishMessage(quote.deficit===0?'Posição já atingiu a meta.':quote.dry_available<quote.deficit?'Estoque seco insuficiente para atingir a meta.':quote.expired_dry>0?'Lotes vencidos não foram incluídos.':'Confira os lotes antes de confirmar.');
    }catch(error){if(stamp===generation)replenishMessage(safeError(error));}
    finally{if(stamp===generation){busy=false;sync();}}
  }
  el('fridgeReplenishQuantity').addEventListener('input',syncReplenish);
  el('fridgeReplenishQuote').addEventListener('click',()=>{
    const input=el('fridgeReplenishQuantity');
    if(input.value&&!input.checkValidity()){input.reportValidity();return;}
    void quoteReplenishment(input.value?Number(input.value):null);
  });
  el('fridgeReplenishCancel').addEventListener('click',()=>{if(!busy)el('fridgeReplenishDialog').close();});
  el('fridgeReplenishDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  el('fridgeReplenishForm').addEventListener('submit',async e=>{
    e.preventDefault();
    if(!replenishQuote||!replenishSlot||busy||!navigator.onLine||el('fridgeReplenishConfirm').disabled)return;
    const {client,shop}=getContext(),stamp=generation;
    const args={p_shop_id:shop.shop_id,p_slot_id:replenishSlot.id,p_quantity:replenishQuote.quantity,p_plan:replenishQuote.plan};
    const signature=JSON.stringify(args);
    if(replenishRetry?.signature!==signature)replenishRetry={signature,request:crypto.randomUUID()};
    busy=true;sync();replenishMessage('Confirmando reposição…');
    let saved=false;
    try{
      const r=await client.rpc('guigs_replenish_fridge_slot',{...args,p_request_id:replenishRetry.request});
      if(r.error)throw r.error;
      if(!r.data?.event_id)throw Error('Resposta não confirmada. Tente novamente com a mesma sugestão.');
      if(stamp!==generation)return;
      saved=true;replenishRetry=null;el('fridgeReplenishDialog').close();
      msg(r.data.quantity+' un. repostas a partir do estoque seco.');
    }catch(error){if(stamp===generation)replenishMessage(safeError(error));}
    finally{if(stamp===generation){busy=false;sync();}}
    if(saved&&stamp===generation){
      await load({announce:false});
      if(refreshStock&&stamp===generation)await refreshStock();
    }
  });
  const allocationLot=()=>data?.unallocated.find(l=>l.lot_id===el('fridgeAllocationLot').value);
  function allocationEntries(){
    const lot=allocationLot();
    if(!lot)return [];
    return [...el('fridgeAllocationDestinations').querySelectorAll('input[data-slot]')]
      .filter(i=>Number(i.value)>0).map(i=>({lot_id:lot.lot_id,slot_id:i.dataset.slot,quantity:Number(i.value)}));
  }
  function allocationSummary(){
    const lot=allocationLot(),entries=allocationEntries();
    const total=entries.reduce((n,e)=>n+e.quantity,0);
    el('fridgeAllocationSummary').textContent=lot?'Disponível: '+lot.quantity+' un. · Distribuir: '+total+' un. · Restam não alocadas: '+(lot.quantity-total)+' un.':'Selecione um lote disponível.';
    el('fridgeConfirmAllocation').disabled=!owner()||busy||!navigator.onLine||!lot||total<1||total>lot.quantity||
      !el('fridgeAllocationForm').checkValidity();
  }
  function renderAllocationDestinations(){
    const target=el('fridgeAllocationDestinations');target.replaceChildren();
    const lot=allocationLot();
    if(lot){
      for(const slot of data.slots){
        const f=data.fridges.find(f=>f.id===slot.fridge_id),h=data.shelves.find(h=>h.id===slot.shelf_id);
        const max=Math.min(Number(lot.quantity),slot.capacity_quantity-Number(slot.quantity));
        if(!slot.active||!f?.active||!h?.active||max<1||(slot.product_id&&slot.product_id!==lot.product_id))continue;
        const field=node('div');field.className='field';
        const input=node('input');input.id='allocate-'+slot.id;input.type='number';input.min=0;input.max=max;input.step=1;input.value=0;input.dataset.slot=slot.id;
        const label=node('label',f.name+' / '+h.name+' / '+slot.name+' · até '+max+' un.');label.htmlFor=input.id;
        field.append(label,input);target.append(field);
      }
      if(!target.children.length)target.append(node('p','Nenhuma posição compatível com espaço disponível.'));
    }
    allocationSummary();
  }
  el('fridgeAllocate').addEventListener('click',()=>{
    if(!owner()||busy||!navigator.onLine||!data)return;
    const lots=data.unallocated.filter(l=>l.quantity>0);
    if(!lots.length)return;
    el('fridgeAllocationLot').replaceChildren(...lots.map(l=>option(l.lot_id,l.product_name+' · '+l.code+' · '+l.quantity+' un.')));
    allocationMessage('');el('fridgeAllocationDialog').showModal();renderAllocationDestinations();sync();
  });
  el('fridgeAllocationLot').addEventListener('change',renderAllocationDestinations);
  el('fridgeAllocationDestinations').addEventListener('input',allocationSummary);
  el('fridgeCancelAllocation').addEventListener('click',()=>{if(!busy)el('fridgeAllocationDialog').close();});
  el('fridgeAllocationDialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  el('fridgeAllocationForm').addEventListener('submit',async event=>{
    event.preventDefault();
    if(!owner()||busy||!navigator.onLine||el('fridgeConfirmAllocation').disabled)return;
    const {client,shop}=getContext(),entries=allocationEntries(),stamp=generation;
    const signature=JSON.stringify([shop.shop_id,entries]);
    if(allocationRetry?.signature!==signature)allocationRetry={signature,request:crypto.randomUUID()};
    busy=true;sync();allocationMessage('Confirmando distribuição…');
    let saved=false;
    try{
      const r=await client.rpc('guigs_allocate_fridge_stock',{p_shop_id:shop.shop_id,p_request_id:allocationRetry.request,p_entries:entries});
      if(r.error)throw r.error;
      if(!r.data?.event_id)throw Error('Resposta não confirmada. Tente novamente com os mesmos valores.');
      if(stamp!==generation)return;
      allocationRetry=null;saved=true;el('fridgeAllocationDialog').close();
      msg(r.data.quantity+' un. distribuídas. O total da geladeira não mudou.');
    }catch(error){if(stamp===generation)allocationMessage(safeError(error));}
    finally{if(stamp===generation){busy=false;sync();}}
    if(saved&&stamp===generation)await load({announce:false});
  });
  el('fridgeLayoutForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!owner()||!editing||!data||busy||!navigator.onLine)return;
    const {client,shop}=getContext();const item=selected(),type=kind(),stamp=generation;
    const form=event.currentTarget;
    const values=Object.fromEntries(new FormData(form));
    values.active=form.elements.active.checked;
    if(type==='slot')values.product_id=values.product_id||null;
    for(const key of ['width_ratio','height_ratio','x_ratio','y_ratio'])if(key in values)values[key]=Number(values[key])/100;
    if(!String(values.name||'').trim()){msg('Informe um nome.');return;}
    busy=true;sync();msg('Salvando layout…');
    let saved;
    try{
      const r=await client.rpc('guigs_save_fridge_layout',{p_shop_id:shop.shop_id,p_kind:type,p_values:values,
        p_id:item?.id??null,p_revision:item?.revision??null});
      if(r.error)throw r.error;
      if(!r.data?.id)throw Error('O servidor não confirmou a alteração.');
      saved=r.data;
      if(stamp===generation)msg('Layout salvo. Nenhum saldo foi alterado.');
    }catch(error){if(stamp===generation)msg(safeError(error));}
    finally{if(stamp===generation){busy=false;sync();}}
    if(saved&&stamp===generation)await load({keepId:saved.id,announce:false});
  });
  el('fridgeEditKind').addEventListener('change',()=>renderEditor());
  el('fridgeEditItem').addEventListener('change',renderForm);
  el('fridgeEdit').addEventListener('click',()=>{if(owner()&&navigator.onLine&&data&&!busy){editing=true;restocking=false;renderEditor();sync();}});
  el('fridgeOperate').addEventListener('click',()=>{editing=false;restocking=false;sync();});
  el('fridgeRestockMode').addEventListener('click',()=>{editing=false;restocking=true;renderRestock();sync();});
  el('fridgeRestockFilter').addEventListener('change',()=>{renderRestock();sync();});
  el('fridgeReload').addEventListener('click',()=>void load());
  window.addEventListener('offline',sync);
  window.addEventListener('online',()=>{sync();if(view())void load();});
  return {
    activate(){sync();if(view()&&getContext().shop&&navigator.onLine)void load();},
    reset(){generation++;data=null;photoUrls=new Map();allocationRetry=null;replenishRetry=null;replenishQuote=null;replenishSlot=null;stockQuote=null;stockRetry=null;editing=false;restocking=false;busy=false;pendingRefresh=false;el('fridgeStockDialog').close();el('fridgeReplenishDialog').close();el('fridgeAllocationDialog').close();el('fridgeLayoutFields').replaceChildren();renderMap();renderRestock();msg('');sync();}
  };
}

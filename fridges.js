import {createImageLibrary,storeLibraryImage} from './image-library.js';
import {createFridgeMovesUI} from './fridge-moves.js';
const nouns={fridge:'Geladeira',shelf:'Prateleira',slot:'Posição'};
const collections={fridge:'fridges',shelf:'shelves',slot:'slots'};
const safeError=e=>typeof e?.message==='string'?e.message:'Não foi possível concluir a solicitação.';
const percent=ratio=>Math.round(Number(ratio)*10000)/100;
const imageBucket='guigs-product-images';
const imageExtensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
export function fridgeSlotConfiguration(slot){
  if(slot.capacity_quantity==null||!slot.product_id)return 'PENDENTE';
  return Number(slot.quantity)>0||slot.is_activated===true?'ATIVO':'PRONTO';
}
export function fridgeSlotState({quantity,min_quantity,target_quantity,capacity_quantity}){
  if(capacity_quantity===null)return 'Capacidade pendente';
  const current=Number(quantity);
  return current===0?'VAZIO':current<Number(min_quantity)?'CRÍTICO':current<Number(target_quantity)?'ATENÇÃO':'OK';
}
export function fridgeVisualStatus(slot){
  if(fridgeSlotConfiguration(slot)==='PENDENTE')return {tone:'pending',icon:'○',label:slot.product_id?'Configuração pendente':'Produto pendente',state:'PENDENTE'};
  const state=fridgeSlotState(slot);
  if(state!=='CRÍTICO'&&state!=='ATENÇÃO'&&(slot.min_quantity==null||slot.target_quantity==null))
    return {tone:'pending',icon:'○',label:'Configuração pendente',state:'PENDENTE'};
  return {tone:state==='OK'?'healthy':state==='ATENÇÃO'?'attention':'critical',
    icon:state==='OK'?'✓':state==='ATENÇÃO'?'!':'↓',label:state==='OK'?'Em dia':state==='ATENÇÃO'?'Atenção':state==='VAZIO'?'Vazio':'Crítico',state};
}
const alertLabels={adequate:'Estoque adequado',low:'Abaixo do mínimo',full:'Capacidade atingida',
  pending:'Configuração pendente',capacity:'Capacidade pendente',expiry:'Atenção à validade',empty:'Vazio'};
const normalizeMapText=value=>value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu,'');
export function fridgeSlotAlerts(slot,today=new Date().toISOString().slice(0,10)){
  const quantity=Number(slot.quantity),capacity=slot.capacity_quantity,minimum=slot.min_quantity;
  const pending=!slot.product_id||minimum==null||slot.target_quantity==null||capacity==null;
  const low=minimum!=null&&quantity<Number(minimum);
  const expiryLimit=new Date(today+'T00:00:00Z');
  expiryLimit.setUTCDate(expiryLimit.getUTCDate()+30);
  const last=expiryLimit.toISOString().slice(0,10);
  return {
    adequate:!pending&&!low&&quantity<=Number(capacity),low,full:capacity!=null&&quantity===Number(capacity),
    pending,capacity:capacity==null,expiry:(slot.lots||[]).some(lot=>Number(lot.quantity)>0&&lot.expiry>=today&&lot.expiry<=last),
    empty:quantity===0
  };
}
export function fridgeDraftGeometry(x,width){
  const w=Math.min(1,Math.max(.05,Number(width)||.05));
  return {x_ratio:Math.round(Math.min(1-w,Math.max(0,Number(x)||0))*10000)/10000,width_ratio:Math.round(w*10000)/10000};
}
const physicalOrder=(axis)=>(a,b)=>Number(a[axis])-Number(b[axis])||a.sort_order-b.sort_order||a.id.localeCompare(b.id);
export function fridgeReplenishmentRows(data,today){
  const f=new Map(data.fridges.filter(x=>x.active).map(x=>[x.id,x]));
  const h=new Map(data.shelves.filter(x=>x.active&&f.has(x.fridge_id)).map(x=>[x.id,x]));
  const dry=new Map();
  for(const lot of data.dry)if(lot.expiry>=today&&lot.product_active&&lot.quantity>0)
    dry.set(lot.product_id,(dry.get(lot.product_id)||0)+Number(lot.quantity));
  const rows=data.slots.filter(x=>x.active&&x.capacity_quantity!=null&&x.target_quantity!=null&&x.product_active&&x.product_id&&f.has(x.fridge_id)&&h.has(x.shelf_id))
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

export function createFridgesUI({getContext,refreshStock,confirmAction,openTransfer}){
  const el=id=>document.getElementById(id);
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const owner=()=>getContext().shop?.role==='owner';
  const canManageLayout=()=>owner()||data?.can_manage_layout===true;
  const view=()=>location.hash==='#geladeiras';
  const msg=text=>{el('fridgeMessage').textContent=text;};
  let data=null, editing=false, restocking=false, busy=false, generation=0, pendingRefresh=false;
  let photoUrls=new Map();
  const library=createImageLibrary({getContext,canManage:canManageLayout,onApplied:async(id,path)=>{const p=(getContext().products||[]).find(p=>p.id===id);if(p)p.image_path=path;await load({announce:false});}});
  let detailSlotId=null,dragging=false;
  let allocationRetry=null;
  let replenishSlot=null, replenishQuote=null, replenishRetry=null;
  let stockQuote=null, stockRetry=null;
  let mapCards=[];
  const moves=createFridgeMovesUI({getContext,getMap:()=>data,openDetail:(...args)=>{if(view())openDetail(...args);},
    refreshMap:()=>load({announce:false}),notify:msg});
  const kind=()=>el('fridgeEditKind').value;
  const selected=()=>data?.[collections[kind()]]?.find(row=>row.id===el('fridgeEditItem').value);
  const option=(value,label)=>{const o=node('option',label);o.value=value;return o;};
  function sync(){
    if(!canManageLayout())editing=false;
    const locked=busy||!navigator.onLine;
    el('fridgeEdit').classList.toggle('hidden',!canManageLayout());
    el('fridgeEdit').disabled=locked||!data;
    el('fridgeAllocate').classList.toggle('hidden',!owner());
    el('fridgeMoreActions').classList.toggle('hidden',!owner());
    el('fridgeAllocate').disabled=locked||!data?.unallocated.some(l=>l.quantity>0);
    el('fridgeOperateStock').disabled=locked||!data;
    el('fridgeOperate').setAttribute('aria-pressed',String(!editing&&!restocking));
    el('fridgeRestockMode').setAttribute('aria-pressed',String(restocking));
    el('fridgeEdit').setAttribute('aria-pressed',String(editing));
    el('fridgeEditor').classList.toggle('hidden',!editing);
    el('fridgeMap').classList.toggle('hidden',editing||restocking);
    el('fridgeMapFilters').classList.toggle('hidden',editing||restocking);
    el('fridgeMapFilterSummary').classList.toggle('hidden',editing||restocking);
    el('fridgeRestockView').classList.toggle('hidden',!restocking);
    el('fridgeOffline').classList.toggle('hidden',navigator.onLine);
    el('fridgeReload').disabled=locked;
    el('fridgeLayoutFields').disabled=locked;
    el('fridgeSaveLayout').disabled=locked||!editing||!data;
    el('fridgeEditKind').disabled=locked;
    el('fridgeEditItem').disabled=locked;
    el('fridgeImageProduct').disabled=locked;
    el('fridgeImageFile').disabled=locked;
    el('fridgeImageUpload').disabled=locked||!editing||!canManageLayout()||!imageProduct();
    el('fridgeImageRemove').disabled=locked||!editing||!canManageLayout()||!imageProduct()?.image_path;
    for(const action of el('fridgeEditor').querySelectorAll('[data-draft-action]'))action.disabled=locked;
    if(el('fridgeDetailDialog').open)syncDetail();
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
    moves.sync(locked);
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
      if(!item||type==='slot'){
        const f=field('fridge_id','Geladeira',{options:[['','Selecione'],...data.fridges.map(x=>[x.id,x.name])],value:item?.fridge_id,required:true});
        if(type==='slot'){
          const h=field('shelf_id','Prateleira',{options:[['','Selecione'],...data.shelves.filter(x=>x.fridge_id===f.value).map(x=>[x.id,x.name])],value:item?.shelf_id,required:true});
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
        for(const [key,label] of [['min_quantity','Mínimo'],['target_quantity','Meta']]){
          field(key,label,{type:'number',value:item?.[key],min:0,max:1000000,step:1}).placeholder='Não configurado';
        }
        const capacity=field('capacity_quantity','Capacidade',{type:'number',value:item?.capacity_quantity,min:1,max:1000000,step:1});
        capacity.placeholder='Capacidade pendente';
      }
    }
    const advanced=node('details');advanced.className='fridge-advanced';
    advanced.append(node('summary','Valores precisos e ordem'));
    for(const input of [...fields.querySelectorAll('input')])if(/(_ratio|sort_order)$/.test(input.name))advanced.append(input.parentElement);
    fields.append(advanced);
    for(const input of fields.querySelectorAll('input,select')){input.addEventListener('input',()=>{if(!dragging)renderEditorPreview();});input.addEventListener('change',()=>{if(!dragging)renderEditorPreview();});}
    renderEditorPreview();
  }
  function selectEditorItem(type,id){
    if(!canManageLayout()||busy||!navigator.onLine)return;
    editing=true;restocking=false;el('fridgeEditKind').value=type;renderEditor(id);imageProductFromSlot();sync();
  }
  function imageProductFromSlot(){if(kind()==='slot'){const id=selected()?.product_id;el('fridgeImageProduct').value=id||'';}sync();}
  function draftNumber(name,fallback){const input=el('fridgeField_'+name);return input?Number(input.value)/100:fallback;}
  function setDraftGeometry(x,width){
    const next=fridgeDraftGeometry(x,width);
    el('fridgeField_x_ratio').value=percent(next.x_ratio);el('fridgeField_width_ratio').value=percent(next.width_ratio);
    return next;
  }
  function renderEditorPreview({keepControls=false}={}){
    const preview=el('fridgeEditorPreview'),controls=el('fridgeDraftControls');preview.replaceChildren();if(!keepControls)controls.replaceChildren();
    if(!data)return;
    const type=kind(),item=selected(),draft={...item,id:item?.id||'draft-new',name:el('fridgeField_name')?.value||'Novo '+nouns[type].toLowerCase(),active:el('fridgeField_active')?.checked??true};
    for(const key of ['width_ratio','height_ratio','x_ratio','y_ratio'])draft[key]=draftNumber(key,item?.[key]??(key.endsWith('width_ratio')||key==='height_ratio'?1:0));
    for(const key of ['fridge_id','shelf_id'])if(el('fridgeField_'+key))draft[key]=el('fridgeField_'+key).value;
    const rows=key=>key===collections[type]?[...data[key].filter(x=>x.id!==draft.id),draft]:data[key];
    for(const f of rows('fridges').filter(x=>x.active)){
      const cabinet=node('section');cabinet.className='fridge-preview-cabinet';
      const heading=node('button',f.name);heading.type='button';heading.className='fridge-preview-heading';heading.dataset.draftAction='select';heading.addEventListener('click',()=>selectEditorItem('fridge',f.id==='draft-new'?'':f.id));cabinet.append(heading);
      for(const h of rows('shelves').filter(h=>h.active&&h.fridge_id===f.id).sort(physicalOrder('y_ratio'))){
        const shelf=node('section');shelf.className='fridge-preview-shelf';shelf.style.setProperty('--draft-height',String(h.height_ratio));
        const title=node('button',h.name);title.type='button';title.className='fridge-preview-heading';title.dataset.draftAction='select';title.addEventListener('click',()=>selectEditorItem('shelf',h.id==='draft-new'?'':h.id));shelf.append(title);
        const rail=node('div');rail.className='fridge-draft-rail';const ends=[];
        for(const slot of rows('slots').filter(x=>x.active&&x.shelf_id===h.id).sort(physicalOrder('x_ratio'))){
          const box=node('div');box.className='fridge-draft-block';const active=type==='slot'&&slot.id===draft.id;box.classList.toggle('is-selected',active);
          const start=Math.min(96,Math.floor(percent(slot.x_ratio))+1),end=Math.min(101,Math.max(start+5,Math.ceil(percent(Number(slot.x_ratio)+Number(slot.width_ratio)))+1));
          let lane=ends.findIndex(e=>e<=start);if(lane<0)lane=ends.length;ends[lane]=end;
          box.style.gridColumn=start+' / '+end;box.style.gridRow=String(lane+1);
          const choose=node('button',slot.name);choose.type='button';choose.className='fridge-draft-select';choose.dataset.draftAction='select';choose.setAttribute('aria-label','Editar bloco '+slot.name);choose.addEventListener('click',()=>selectEditorItem('slot',slot.id==='draft-new'?'':slot.id));box.append(choose);
          if(active){
            for(const [action,label,icon]of [['move','Arrastar bloco','↔'],['resize','Redimensionar bloco','↗']]){
              const handle=node('button',icon);handle.type='button';handle.dataset.draftAction=action;handle.setAttribute('aria-label',label);handle.className='fridge-drag-handle';
              handle.addEventListener('pointerdown',event=>{
                if(event.button!==0||busy||!navigator.onLine)return;
                event.preventDefault();dragging=true;handle.setPointerCapture(event.pointerId);
                const origin={clientX:event.clientX,x:draft.x_ratio,width:draft.width_ratio},size=rail.getBoundingClientRect().width;
                const move=e=>{
                  if(!dragging||!navigator.onLine||busy)return;
                  const delta=(e.clientX-origin.clientX)/size;
                  const next=setDraftGeometry(action==='move'?origin.x+delta:origin.x,action==='resize'?Math.min(1-origin.x,origin.width+delta):origin.width);
                  box.style.gridColumn=(Math.floor(percent(next.x_ratio))+1)+' / '+(Math.ceil(percent(next.x_ratio+next.width_ratio))+1);
                };
                const finish=()=>{dragging=false;handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish);renderEditorPreview();msg('Prévia alterada. Salve o layout para confirmar.');sync();};
                handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);
              });
              handle.addEventListener('keydown',event=>{
                if(!['ArrowLeft','ArrowRight'].includes(event.key)||busy||!navigator.onLine)return;
                event.preventDefault();const step=event.key==='ArrowLeft'?-.05:.05;
                setDraftGeometry(draftNumber('x_ratio',0)+(action==='move'?step:0),draftNumber('width_ratio',1)+(action==='resize'?step:0));renderEditorPreview();
                controls.querySelector('input')?.focus();msg('Prévia alterada. Salve o layout para confirmar.');
              });box.append(handle);
            }
          }
          rail.append(box);
        }
        if(!rail.children.length)rail.append(node('p','Adicione um bloco neste nível.'));shelf.append(rail);cabinet.append(shelf);
      }
      preview.append(cabinet);
    }
    if(keepControls)return;
    const slider=(name,label,min,max)=>{
      const field=el('fridgeField_'+name);if(!field)return;
      const wrap=node('label',label),input=node('input');input.type='range';input.min=min;input.max=max;input.step=1;input.value=field.value;input.dataset.draftAction='range';input.setAttribute('aria-label',label);
      input.addEventListener('input',()=>{
        field.value=input.value;
        if(type==='slot')setDraftGeometry(draftNumber('x_ratio',0),name==='width_ratio'?Math.min(draftNumber('width_ratio',1),1-draftNumber('x_ratio',0)):draftNumber('width_ratio',1));
        input.value=field.value;renderEditorPreview({keepControls:true});

        msg('Prévia alterada. Salve o layout para confirmar.');
      });wrap.append(input);controls.append(wrap);
    };
    if(type==='fridge')slider('width_ratio','Tamanho da geladeira',25,100);
    if(type==='shelf'){slider('y_ratio','Posição do nível',0,95);slider('height_ratio','Altura do nível',5,100);}
    if(type==='slot'){slider('x_ratio','Posição do bloco',0,95);slider('width_ratio','Tamanho do bloco',5,100);}
    const actions=node('div');actions.className='inventory-actions';
    if(type==='slot'&&item){
      const duplicate=node('button','Duplicar estrutura');duplicate.type='button';duplicate.dataset.draftAction='duplicate';
      duplicate.addEventListener('click',()=>{
        if(!canManageLayout()||busy||!navigator.onLine)return;
        const source=selected();renderEditor();
        for(const [key,value]of Object.entries({name:source.name+' — cópia',fridge_id:source.fridge_id,shelf_id:source.shelf_id,x_ratio:percent(source.x_ratio),width_ratio:percent(source.width_ratio)})){
          const input=el('fridgeField_'+key);if(input){input.value=value;if(key==='fridge_id')input.dispatchEvent(new Event('change'));}
        }
        renderEditorPreview();msg('Cópia em rascunho, sem produto ou capacidade. Revise e salve.');
      });actions.append(duplicate);
    }
    for(const [offset,label]of [[-1,'Antes'],[1,'Depois']]){
      const move=node('button',label);move.type='button';move.dataset.draftAction='order';move.addEventListener('click',()=>{
        if(busy||!navigator.onLine)return;
        const field=el('fridgeField_'+(type==='fridge'?'sort_order':type==='shelf'?'y_ratio':'x_ratio'));
        field.value=Math.max(0,Math.min(type==='fridge'?10000:95,Number(field.value)+offset*(type==='fridge'?1:5)));
        if(type==='slot')setDraftGeometry(draftNumber('x_ratio',0),draftNumber('width_ratio',1));renderEditorPreview();msg('Ordem em rascunho. Salve para confirmar.');
      });actions.append(move);
    }
    controls.append(actions,node('small','Arraste os controles do bloco selecionado ou use as setas do teclado. Mudar a prévia não movimenta bebidas.'));
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
    renderImageProducts();
    el('fridgeRemoveLayout').disabled=!itemForRemoval()||busy||!navigator.onLine;
    void loadLayoutAccess().catch(error=>msg(safeError(error)));
  }
  function imageProduct(){const p=(getContext().products||[]).find(p=>p.id===el('fridgeImageProduct').value);if(!p)return null;const slot=data?.slots.find(s=>s.product_id===p.id);return {product_id:p.id,product_name:p.name,image_path:slot?slot.image_path:p.image_path};}
  function renderImageProducts(){
    const select=el('fridgeImageProduct'),previous=select.value;
    const choices=new Map();
    for(const p of getContext().products||[])if(p.active||p.image_path)choices.set(p.id,p.name);
    select.replaceChildren(option('','Selecione um produto'),...[...choices].map(([id,name])=>option(id,name)));
    if(choices.has(previous))select.value=previous;
  }
  function photo(slot,large=false){
    const wrap=node('span');wrap.className='fridge-photo-wrap'+(large?' fridge-photo-large':'');
    const path=slot.image_path||(slot.lots?.length&&new Set(slot.lots.map(l=>l.product_id)).size===1?slot.lots[0].image_path:null);
    if(path)wrap.dataset.photoPath=path;
    fillPhoto(wrap);return wrap;
  }
  function fillPhoto(wrap){
    const fallback=()=>{const n=node('span');n.className='fridge-photo fridge-photo-fallback';n.setAttribute('aria-hidden','true');wrap.replaceChildren(n);};
    const url=photoUrls.get(wrap.dataset.photoPath);
    if(!url){fallback();return;}
    const img=node('img');img.className='fridge-photo';img.src=url;img.alt='';img.loading='lazy';img.decoding='async';
    img.addEventListener('error',fallback,{once:true});wrap.replaceChildren(img);
  }
  function statusBadge(slot){
    const state=fridgeVisualStatus(slot),badge=node('span');badge.className='fridge-state';badge.dataset.state=state.state;
    const icon=node('span',state.icon);icon.setAttribute('aria-hidden','true');badge.append(icon,document.createTextNode(' '+state.label));
    return badge;
  }
  function alertBadges(flags,primary){
    const badges=node('span');badges.className='fridge-alerts';
    for(const [key,label] of Object.entries(alertLabels))if(flags[key]&&label!==primary){
      const badge=node('span',label);badge.className='fridge-alert';badge.dataset.alert=key;badges.append(badge);
    }
    return badges;
  }
  function filterMap(){
    const words=normalizeMapText(el('fridgeMapSearch').value.trim()).split(/\s+/).filter(Boolean);
    const stock=el('fridgeMapStock').value;
    const alerts=[...el('fridgeMapFilters').querySelectorAll('input[type=checkbox]:checked')].map(input=>input.value);
    let visible=0;
    for(const {card,text,flags} of mapCards){
      const matches=words.every(word=>text.includes(word))&&alerts.every(alert=>flags[alert])&&
        (stock==='all'||(stock==='empty'?flags.empty:!flags.empty));
      card.classList.toggle('hidden',!matches);
      if(matches)visible++;
    }
    el('fridgeMapFilterSummary').textContent=data?visible+' de '+mapCards.length+' blocos exibidos.':'';
  }
  function renderMap(){
    const map=el('fridgeMap'),focused=document.activeElement?.dataset?.openSlot;map.replaceChildren();mapCards=[];
    if(!data){filterMap();return;}
    const enabled=data.fridges.filter(f=>f.active),summary=node('div');summary.className='fridge-map-summary';
    const fridgeIds=new Set(enabled.map(f=>f.id)), shelfIds=new Set();
    const shelvesByFridge=new Map(), slotsByShelf=new Map();
    for(const shelf of data.shelves)if(shelf.active&&fridgeIds.has(shelf.fridge_id)){
      shelfIds.add(shelf.id);
      if(!shelvesByFridge.has(shelf.fridge_id))shelvesByFridge.set(shelf.fridge_id,[]);
      shelvesByFridge.get(shelf.fridge_id).push(shelf);
    }
    const alerts=data.slots.filter(slot=>slot.active&&shelfIds.has(slot.shelf_id));
    for(const slot of alerts){
      if(!slotsByShelf.has(slot.shelf_id))slotsByShelf.set(slot.shelf_id,[]);
      slotsByShelf.get(slot.shelf_id).push(slot);
    }
    const count=tone=>alerts.filter(s=>fridgeVisualStatus(s).tone===tone).length;
    summary.append(node('strong','De olho nas bebidas'),node('span',count('critical')+' críticas · '+count('attention')+' em atenção · '+count('pending')+' pendentes'));
    map.append(summary);
    if(!enabled.length)map.append(node('p','Nenhuma geladeira ativa. O saldo legado permanece não alocado.'));
    const cabinets=node('div');cabinets.className='fridge-cabinets';
    for(const f of enabled){
      const block=node('section');block.className='fridge-cabinet';block.style.setProperty('--cabinet-width',percent(f.width_ratio)*.48+'%');
      const header=node('header'),title=node('h3',f.name);title.id='fridge-cabinet-'+f.id;header.className='fridge-cabinet-header';
      const light=node('span','●');light.className='fridge-cabinet-light';light.setAttribute('aria-hidden','true');
      block.setAttribute('aria-labelledby',title.id);header.append(title,light);block.append(header);
      const glass=node('div');glass.className='fridge-glass';
      const shelves=(shelvesByFridge.get(f.id)||[]).sort(physicalOrder('y_ratio'));
      if(!shelves.length)glass.append(node('p','Sem prateleiras ativas.'));
      for(const h of shelves){
        const shelf=node('section');shelf.className='fridge-shelf';
        const shelfTitle=node('h4',h.name);shelfTitle.id='fridge-shelf-'+h.id;shelf.setAttribute('aria-labelledby',shelfTitle.id);shelf.append(shelfTitle);
        const rail=node('div');rail.className='fridge-rail';rail.style.setProperty('--shelf-size',String(h.height_ratio));
        const slots=(slotsByShelf.get(h.id)||[]).sort(physicalOrder('x_ratio'));
        if(!slots.length)rail.append(node('p','Sem blocos.'));
        const laneEnds=[];
        for(const x of slots){
          const start=Math.min(85,Math.floor(percent(x.x_ratio))+1),end=Math.max(start+16,Math.min(101,Math.ceil(percent(Number(x.x_ratio)+Number(x.width_ratio)))+1));
          let lane=laneEnds.findIndex(e=>e<=start);if(lane<0)lane=laneEnds.length;laneEnds[lane]=end;
          const state=fridgeVisualStatus(x),card=node('article');card.className='fridge-slot';card.dataset.slotId=x.id;card.dataset.tone=state.tone;
          const flags=fridgeSlotAlerts(x);
          mapCards.push({card,flags,text:normalizeMapText([x.product_name,x.name,f.name,h.name].filter(Boolean).join(' '))});
          card.style.setProperty('--slot-column',start+' / '+end);card.style.setProperty('--slot-row',String(lane+1));
          const button=node('button');button.type='button';button.className='fridge-slot-open';button.dataset.openSlot=x.id;button.setAttribute('aria-haspopup','dialog');
          const name=x.product_name||x.name;
          const showQuantity=state.tone!=='pending'||Number(x.quantity)>0;
          const activeAlerts=Object.keys(flags).filter(key=>flags[key]&&alertLabels[key]!==state.label).map(key=>alertLabels[key]);
          button.setAttribute('aria-label',name+' · '+state.label+(showQuantity?' · '+x.quantity+' unidades':'')+' · '+f.name+' / '+h.name+' / '+x.name+
            (activeAlerts.length?' · '+activeAlerts.join(' · '):''));
          button.append(photo(x));const label=node('span',name);label.className='fridge-slot-name';button.append(label,statusBadge(x),alertBadges(flags,state.label));
          if(showQuantity){const quantity=node('span',x.quantity+' un.');quantity.className='fridge-slot-quantity';button.append(quantity);}
          button.addEventListener('click',()=>openDetail(x.id));card.append(button);rail.append(card);
        }
        shelf.append(rail);glass.append(shelf);
      }
      block.append(glass);const base=node('div','GUIG’S  ·  BEBIDAS');base.className='fridge-cabinet-base';block.append(base);cabinets.append(block);
    }
    const unallocated=node('details');unallocated.className='fridge-unallocated';
    unallocated.append(node('summary','Geladeira — não alocado · '+data.unallocated.reduce((sum,l)=>sum+Number(l.quantity),0)+' un. sem posição física'));
    if(data.unallocated.length){const list=node('ul');for(const l of data.unallocated)list.append(node('li',l.product_name+' · '+l.code+' · '+l.quantity+' un. · '+l.expiry.split('-').reverse().join('/')));unallocated.append(list);}
    map.append(cabinets,unallocated);
    filterMap();
    if(focused)map.querySelector('[data-open-slot="'+focused+'"]')?.focus({preventScroll:true});
  }
  function detailSlot(){return data?.slots.find(s=>s.id===detailSlotId);}
  function syncDetail(){
    const slot=detailSlot(),locked=busy||!navigator.onLine;
    el('fridgeDetailMove').disabled=locked||!slot||(!slot.lots.some(lot=>lot.quantity>0)&&!moves.hasRetry(slot.id));
    el('fridgeDetailTransfer').disabled=locked||!slot?.product_active||slot.capacity_quantity==null||Number(slot.quantity)>=slot.capacity_quantity;
    el('fridgeDetailReplenish').disabled=locked||!slot||fridgeSlotConfiguration(slot)==='PENDENTE'||slot.target_quantity==null||!slot.product_active;
    el('fridgeDetailEdit').classList.toggle('hidden',!canManageLayout());el('fridgeDetailProduct').classList.toggle('hidden',!canManageLayout());
    el('fridgeDetailEdit').disabled=locked;el('fridgeDetailProduct').disabled=locked;
    el('fridgeDetailStock').disabled=locked||!slot?.product_id||fridgeSlotConfiguration(slot)==='PENDENTE'||(!owner()&&Number(slot.quantity)===0);
    el('fridgeDetailStock').textContent=owner()?'Venda, perda, retorno ou ajuste':'Venda, perda ou retorno';
    el('fridgeDetailOffline').classList.toggle('hidden',navigator.onLine);
  }
  function openDetail(id,showHistory=false,feedback=''){
    const slot=data?.slots.find(s=>s.id===id);if(!slot)return;
    detailSlotId=id;moves.resetHistory(id);renderDetail();
    if(!el('fridgeDetailDialog').open)el('fridgeDetailDialog').showModal();
    if(feedback)el('fridgeDetailBody').prepend(Object.assign(node('p',feedback),{className:'notice good',role:'status'}));
    if(showHistory)el('fridgeSlotHistory').open=true;
    syncDetail();
  }
  function renderDetail(){
    const slot=detailSlot();
    if(!slot?.active||!data.fridges.some(f=>f.active&&f.id===slot.fridge_id)||!data.shelves.some(h=>h.active&&h.id===slot.shelf_id)){
      el('fridgeDetailDialog').close();msg('Este bloco não está mais disponível no mapa.');return;
    }
    const f=data.fridges.find(f=>f.id===slot.fridge_id),h=data.shelves.find(h=>h.id===slot.shelf_id),state=fridgeVisualStatus(slot),pending=state.tone==='pending';
    el('fridgeDetailTitle').textContent=slot.product_name||slot.name;
    el('fridgeDetailLocation').textContent=[f?.name,h?.name,slot.name].filter(Boolean).join(' / ');
    const body=el('fridgeDetailBody');body.replaceChildren();
    const hero=node('div');hero.className='fridge-detail-hero';const text=node('div');
    text.append(statusBadge(slot),node('p',fridgeSlotConfiguration(slot)==='PRONTO'?'Pronto para abastecer':fridgeSlotConfiguration(slot)==='ATIVO'?'Bloco ativo':'Configuração pendente'));
    text.append(alertBadges(fridgeSlotAlerts(slot),state.label));
    hero.append(photo(slot,true),text);body.append(hero);
    if(pending){
      const guidance=!slot.product_id?'Associe um produto para preparar este bloco.':
        slot.capacity_quantity==null?'Defina a capacidade para ativar este bloco.':'Configure o mínimo e a meta do bloco.';
      const note=node('p',guidance);note.className='notice';body.append(note);
    }
    const stats=node('dl');stats.className='fridge-detail-stats';
    const stat=(label,value)=>{const cell=node('div');cell.append(node('dt',label),node('dd',String(value)));stats.append(cell);};
    stat('No bloco',slot.quantity+' un.');
    const threshold=value=>value==null?'Não configurado':value+' un.';
    stat('Mínimo',threshold(slot.min_quantity));
    stat('Meta desejada',threshold(slot.target_quantity));
    stat('Capacidade',threshold(slot.capacity_quantity));
    if(slot.capacity_quantity!=null){
      stat('Ocupação',Math.round(Number(slot.quantity)/slot.capacity_quantity*100)+'%');
      const meter=node('meter');meter.min=0;meter.max=slot.capacity_quantity;meter.value=slot.quantity;meter.setAttribute('aria-label','Ocupação de '+slot.name);body.append(meter);
    }
    const today=new Date().toISOString().slice(0,10),dry=data.dry.filter(l=>l.product_id===slot.product_id),unallocated=data.unallocated.filter(l=>l.product_id===slot.product_id);
    stat('Seco disponível',dry.filter(l=>l.expiry>=today&&l.product_active).reduce((n,l)=>n+Number(l.quantity),0)+' un. elegíveis');
    stat('Não alocado',unallocated.reduce((n,l)=>n+Number(l.quantity),0)+' un.');body.append(stats);
    const lots=node('details');lots.id='fridgeDetailLots';lots.append(node('summary','Lotes e validade · FEFO'));
    const group=(title,rows)=>{
      lots.append(node('h4',title));if(!rows.length){lots.append(node('p','Nenhum lote.'));return;}
      const list=node('ul');
      for(const l of rows)list.append(node('li',l.code+' · '+l.quantity+' un. · '+l.expiry.split('-').reverse().join('/')+(l.expiry<today?' · Vencido':'')));
      lots.append(list);
    };
    group('Neste bloco',slot.lots);group('Estoque seco',dry);group('Geladeira — não alocado',unallocated);
    lots.append(node('p','A reposição confirma os lotes elegíveis e a ordem FEFO no servidor antes de gravar.'));body.append(lots);
  }
  function editFromDetail(product=false){
    if(!canManageLayout()||busy||!navigator.onLine)return;
    const id=detailSlotId;el('fridgeDetailDialog').close();selectEditorItem('slot',id);
    if(product)el('fridgeField_product_id')?.focus();else el('fridgeEditorTitle').focus();
  }
  el('fridgeDetailClose').addEventListener('click',()=>el('fridgeDetailDialog').close());
  el('fridgeDetailMove').addEventListener('click',()=>{if(!el('fridgeDetailMove').disabled)moves.open(detailSlot());});
  el('fridgeDetailTransfer').addEventListener('click',()=>{
    const slot=detailSlot();
    if(!slot||el('fridgeDetailTransfer').disabled)return;
    el('fridgeDetailDialog').close();
    void openTransfer?.(slot);
  });
  el('fridgeDetailDialog').addEventListener('close',()=>{
    const id=detailSlotId;detailSlotId=null;
    if(!editing&&!document.querySelector('dialog[open]'))el('fridgeMap').querySelector('[data-open-slot="'+id+'"]')?.focus({preventScroll:true});
  });
  el('fridgeDetailEdit').addEventListener('click',()=>editFromDetail());
  el('fridgeDetailProduct').addEventListener('click',()=>editFromDetail(true));
  el('fridgeDetailShowLots').addEventListener('click',()=>{el('fridgeDetailLots').open=true;el('fridgeDetailLots').querySelector('summary').focus();});
  el('fridgeDetailReplenish').addEventListener('click',()=>{
    const slot=detailSlot();if(!slot||el('fridgeDetailReplenish').disabled)return;
    el('fridgeDetailDialog').close();openReplenish(slot,data.fridges.find(f=>f.id===slot.fridge_id),data.shelves.find(h=>h.id===slot.shelf_id));
  });
  el('fridgeDetailStock').addEventListener('click',()=>{
    const slot=detailSlot();if(!slot||el('fridgeDetailStock').disabled)return;
    el('fridgeDetailDialog').close();el('fridgeOperateStock').click();
    if([...el('fridgeStockProduct').options].some(o=>o.value===slot.product_id)){
      el('fridgeStockProduct').value=slot.product_id;stockOrigins();
      if([...el('fridgeStockOrigin').options].some(o=>o.value===slot.id)){el('fridgeStockOrigin').value=slot.id;stockLots();}
    }
  });
  async function loadPhotos(next,client,stamp){
    const paths=[...new Set(next.slots.flatMap(x=>[x.image_path,...x.lots.map(l=>l.image_path)]).filter(Boolean))];
    if(!paths.length||!client.storage||!client.supabaseUrl)return;
    try{
      const {data:signed}=await client.storage.from(imageBucket).createSignedUrls(paths,300);
      if(stamp!==generation||next!==data)return;
      const origin=new URL(client.supabaseUrl).origin;
      for(const entry of signed||[]){
        if(!entry.signedUrl||!paths.includes(entry.path))continue;
        const url=new URL(entry.signedUrl);
        if(url.origin===origin&&url.pathname.startsWith('/storage/v1/object/sign/guigs-product-images/'))photoUrls.set(entry.path,url.href);
      }
      if(photoUrls.size)for(const wrap of document.querySelectorAll('#fridgesView [data-photo-path],#fridgeDetailDialog [data-photo-path],#transferPositions [data-photo-path]'))fillPhoto(wrap);
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
      data=next;photoUrls=new Map();renderMap();if(editing)renderEditor(keepId);if(restocking)renderRestock();if(detailSlotId)renderDetail();
      void loadPhotos(next,client,stamp);
      if(announce)msg('');
      return next;
    }catch(error){if(stamp===generation)msg(safeError(error));}
    finally{
      if(stamp===generation){
        busy=false;sync();
        if(pendingRefresh){pendingRefresh=false;if(view()&&navigator.onLine)void load({announce:false});}
      }
    }
  }
  const allocationMessage=text=>{el('fridgeAllocationMessage').textContent=text;};
  async function setImage(file){
    if(busy||!editing||!canManageLayout()||!navigator.onLine)return;
    const target=imageProduct(),{client,shop}=getContext(),stamp=generation;
    const status=text=>{el('fridgeImageMessage').textContent=text;};
    if(!target||!client||!shop)return;
    const extension=file&&imageExtensions[file.type];
    if(file&&(!extension||file.size<1||file.size>2*1024*1024)){
      status('Escolha PNG, JPEG ou WebP de até 2 MiB.');return;
    }
    if(file&&!client.storage){status('Storage indisponível neste ambiente.');return;}
    busy=true;sync();let saved=false;
    try{
      let imagePath=null;
      if(file){status('Enviando foto…');imagePath=(await storeLibraryImage(client,shop.shop_id,file)).image.storage_path;}
      if(stamp!==generation)return;
      if(!navigator.onLine)throw Error('Conexão indisponível. Atualize o mapa antes de tentar novamente.');
      const r=await client.rpc('guigs_set_product_image',{p_shop_id:shop.shop_id,p_product_id:target.product_id,
        p_path:imagePath,p_expected_path:target.image_path??null});
      if(r.error)throw r.error;
      saved=true;
      const product=(getContext().products||[]).find(p=>p.id===target.product_id);if(product)product.image_path=imagePath;
      if(stamp!==generation)return;
      el('fridgeImageFile').value='';status(file?'Foto salva.':'Associação removida. O arquivo continua na biblioteca.');
    }catch(error){
      // Não apaga em erro de rede no RPC: o servidor pode ter confirmado o vínculo.
      if(stamp===generation)status(safeError(error));
    }
    finally{if(stamp===generation){busy=false;sync();}}
    if(saved&&stamp===generation)await load({announce:false});
  }
  el('fridgeImageLibrary').addEventListener('click',()=>library.open(imageProduct()));
  el('fridgeDetailLibrary').addEventListener('click',()=>{const slot=detailSlot();el('fridgeDetailDialog').close();library.open(slot?.product_id?{product_id:slot.product_id,product_name:slot.product_name,image_path:slot.image_path}:null);});
  el('fridgeImageProduct').addEventListener('change',()=>{el('fridgeImageMessage').textContent='';sync();});
  el('fridgeImageForm').addEventListener('submit',event=>{
    event.preventDefault();const file=el('fridgeImageFile').files[0];if(file)void setImage(file);
  });
  el('fridgeImageRemove').addEventListener('click',async()=>{
    if(!canManageLayout()||busy||!navigator.onLine||!imageProduct()?.image_path)return;
    if(confirmAction&&await confirmAction('Remover associação da foto','A associação será removida. O arquivo continuará na biblioteca. Nenhum saldo será alterado.'))await setImage(null);
  });
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
    const slots=data.slots.filter(s=>s.active&&s.product_id&&s.capacity_quantity!==null&&data.fridges.some(f=>f.active&&f.id===s.fridge_id)&&data.shelves.some(h=>h.active&&h.id===s.shelf_id))
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
      el('fridgeReplenishStats').textContent=quote.product_name+' · Atual: '+quote.current+' / '+quote.capacity+' · Mínimo: '+(quote.min??'Não configurado')+' · Meta: '+quote.target+' · Seco elegível: '+quote.dry_available;
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
        if(!slot.product_id)continue;
        const f=data.fridges.find(f=>f.id===slot.fridge_id),h=data.shelves.find(h=>h.id===slot.shelf_id);
        if(slot.capacity_quantity===null)continue;
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
    event.preventDefault();if(!canManageLayout()||!editing||!data||busy||!navigator.onLine)return;
    const {client,shop}=getContext();const item=selected(),type=kind(),stamp=generation;
    const form=event.currentTarget;
    const values=Object.fromEntries(new FormData(form));
    values.active=form.elements.active.checked;
    if(type==='slot'){
      values.product_id=values.product_id||null;
      for(const key of ['min_quantity','target_quantity','capacity_quantity'])
        values[key]=values[key]===''?null:Number(values[key]);
    }
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
  const itemForRemoval=()=>selected()?.active?selected():null;
  el('fridgeRemoveLayout').addEventListener('click',async()=>{
    const item=itemForRemoval();
    if(!item||busy||!canManageLayout()||!navigator.onLine)return;
    if(!await confirmAction('Remover do mapa','O item será desativado. Saldo existente deve ser realocado antes.'))return;
    el('fridgeLayoutForm').elements.active.checked=false;
    el('fridgeLayoutForm').requestSubmit();
  });
  async function loadLayoutAccess(){
    const panel=el('fridgeLayoutAccess');
    panel.classList.toggle('hidden',!owner()||data?.can_manage_layout===undefined);
    if(!owner()||data?.can_manage_layout===undefined)return;
    const {client,shop}=getContext(),stamp=generation;
    const result=await client.rpc('guigs_list_fridge_layout_access',{p_shop_id:shop.shop_id});
    if(stamp!==generation)return;
    const list=el('fridgeLayoutAccessList');list.replaceChildren();
    if(result.error){list.textContent=safeError(result.error);return;}
    for(const person of result.data||[]){
      const label=node('label'),input=node('input');
      input.type='checkbox';input.checked=person.manage_fridge_layout;
      label.append(input,document.createTextNode(' '+person.email));
      input.addEventListener('change',async()=>{
        if(!owner()||busy||!navigator.onLine){input.checked=!input.checked;return;}
        const allowed=input.checked;
        input.disabled=true;
        const response=await client.rpc('guigs_set_fridge_layout_access',{p_shop_id:shop.shop_id,p_user_id:person.user_id,p_allowed:allowed});
        if(stamp!==generation)return;
        if(response.error){input.checked=!allowed;msg(safeError(response.error));}
        input.disabled=false;
      });
      list.append(label);
    }
    if(!list.children.length)list.textContent='Nenhum atendente ativo.';
  }
  el('fridgeEditKind').addEventListener('change',()=>renderEditor());
  el('fridgeEditItem').addEventListener('change',()=>{renderForm();imageProductFromSlot();});
  el('fridgeEdit').addEventListener('click',()=>{if(canManageLayout()&&navigator.onLine&&data&&!busy){editing=true;restocking=false;renderEditor();sync();}});
  el('fridgeOperate').addEventListener('click',()=>{editing=false;restocking=false;renderMap();sync();});
  el('fridgeRestockMode').addEventListener('click',()=>{editing=false;restocking=true;renderRestock();sync();});
  el('fridgeRestockFilter').addEventListener('change',()=>{renderRestock();sync();});
  el('fridgeMapFilters').addEventListener('input',filterMap);
  el('fridgeReload').addEventListener('click',()=>void load());
  window.addEventListener('offline',sync);
  window.addEventListener('hashchange',()=>{if(!view()){el('fridgeDetailDialog').close();moves.dismiss();library.reset();}});
  return {
    async transferMap(){
      if(!busy)return load({announce:false});
      const {client,shop}=getContext();
      const result=await client.rpc('guigs_get_fridge_map',{p_shop_id:shop.shop_id});
      return result.error ? null : result.data;
    },
    transferPhoto:photo,
    activate(){sync();if(view()&&getContext().shop&&navigator.onLine)void load();},
    reset(){generation++;library.reset();moves.reset();detailSlotId=null;el('fridgeDetailDialog').close();data=null;photoUrls=new Map();allocationRetry=null;replenishRetry=null;replenishQuote=null;replenishSlot=null;stockQuote=null;stockRetry=null;editing=false;restocking=false;busy=false;pendingRefresh=false;el('fridgeStockDialog').close();el('fridgeReplenishDialog').close();el('fridgeAllocationDialog').close();el('fridgeLayoutFields').replaceChildren();el('fridgeMapSearch').value='';el('fridgeMapStock').value='all';for(const input of el('fridgeMapFilters').querySelectorAll('input[type=checkbox]'))input.checked=false;renderMap();renderRestock();msg('');sync();}
  };
}

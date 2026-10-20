/* Destination options and places are loaded from TourAPI.
   These empty identities only keep older saved Seoul/Busan city IDs stable. */
(function(){
  'use strict';
  window.TRAVEL_DATA={countries:{KR:'대한민국'},cities:{
    seoul:{id:'seoul',country:'KR',name:'서울',timezone:'Asia/Seoul',tourAreaCode:'1',supportedDays:0,areas:[]},
    busan:{id:'busan',country:'KR',name:'부산',timezone:'Asia/Seoul',tourAreaCode:'6',supportedDays:0,areas:[]}
  }};
})();

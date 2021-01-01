<?php

namespace App\Http\Controllers;

use App\AccusedStatus;
use App\Decision;
use App\Events\AQOpenEvent;
use App\Events\TemplateSendEvent;
use App\Events\StartTemplateEvent;
use App\Events\CloseTemplateEvent;
use App\Events\SectionsListUpdatedEvent;
use App\Events\NoteOpenEvent;
use App\Events\NoteSendEvent;
use App\Events\NoteCloseEvent;
use App\Events\AdminAQNoteListUpdatedEvent;
use App\Events\AQSendEvent;
use App\Events\AQUpdateEvent;
use App\Events\InvestigationClosedEvent;
use App\Events\PartiesUpdateEvent;
use App\Events\AQNoteListUpdatedEvent;
use App\Events\AQNoteCreateSectionContentEvent;
use App\Events\NoteCreateEvent;
use App\Events\AQCreateEvent;
use App\Events\UpdateInvestigationEvent;
use App\Events\AQBackEvent;
use App\Events\AQStartEvent;
use App\Events\AdminAQNoteCreateSectionContentEvent;
use App\Events\AQCloseEvent;
use App\Events\AdminAQStartEvent;
use App\Events\AQPartyBackEvent;
use App\Events\DirectMessageEvent;
use App\Events\InvestigationReportContentEvent;
use App\Events\PartySecretaryEditEvent;
use App\Events\NewInvestigationEvent;
use App\Events\StartInvestigationEvent;
use App\Events\AQCreatedEvent;
use App\Events\NoteCreatedEvent;
use App\Investigation;
use App\VSummary;
use App\InvestigationAq;
use App\IssueProsecutor;
use App\IssueProsecutorStatusLog;
use App\Notifications\NewInvestigationNotification;
use App\Party;
use App\Prosecutor;
use App\Template;
use App\User;
use App\VInvestigation;
use App\VProsecutorIssue;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use App\InvestigationNote;
use App\VInvestigationAqNote;
use App\InvestigationSession;
use App\VParty;
use PDF;
use App\InvestigationSection;
use App\InvestigationAqNote;
use App\IssueProsecutorLog;
use App\IssueProsecutorUser;

class InvestigationController extends Controller
{
  public function __construct()
  {
    $this->middleware('auth')->except('sessionValidate');
  }

  public function index($issue_prosecutor_id)
  {
    $prosecutor_issue = VSummary::where('id', $issue_prosecutor_id)->where('to_user_id', Auth::id())->first();
    $templates = Template::orderBy('name')->get();
    $user_role = Auth::user()->roles()->first();
    IssueProsecutorLog::create([
      'issue_prosecutor_id' => $issue_prosecutor_id,
      'action_by_id' => Auth::id(),
      'action_to_id' => null,
      'ref_id' => null,
      'current_action' => config()->get('constants.actions.open_all_investigations'),
    ]);
    return view('investigations.index', compact('prosecutor_issue', 'templates', 'user_role')); //,'investigations_reports'));
  }

  public function updateInvestigationReport()
  {
    Investigation::findOrFail(request()->id)->update([
      'report' => request()->report
    ]);
    event(new InvestigationReportContentEvent(request()->id, request()->report, request()->user_id));
  }
  public function saveInvestigationReport()
  {
    $investigation = Investigation::findOrFail(request()->id);
    DB::transaction(function () use ($investigation) {
      IssueProsecutorLog::create([
        'issue_prosecutor_id' => $investigation->issue_prosecutor_id,
        'action_by_id' => Auth::id(),
        'action_to_id' => null,
        'ref_id' => null,
        'current_action' => config()->get('constants.actions.close_investigation'),
      ]);
      $investigation->update([
        'is_closed' => true
      ]);
      event(new InvestigationClosedEvent(request()->id));

      Cache::forget('investigation-online-' . request()->id);
    });
    $this->calcPages($investigation);
  }

  public function indexAq($investigation_id, $party_id, $issue_prosecutor_id)
  {
    $vProsecutorIssues = VProsecutorIssue::findOrFail($issue_prosecutor_id);
    $decisions = Decision::orderBy('title')->get();
    $accusedStatuses = AccusedStatus::orderBy('name')->get();

    return view('investigations.aq', compact('investigation_id', 'party_id', 'decisions', 'issue_prosecutor_id', 'parties', 'accusedStatuses'));
  }

  public function isOnline($id)
  {
    if (Cache::has('online-investigation-' . $id)) {
      return 1;
    }
    return 0;
  }

  public function get($issue_prosecutor)
  {
    $has_full_access = $this->hasInvestigationAccess($issue_prosecutor);

    if (empty($issue_prosecutor)) {
      $inv = VInvestigation::query();
    } else {
      $inv = VInvestigation::where('issue_prosecutor_id', $issue_prosecutor);
    }

    if (!$has_full_access) {
      $inv->where('prosecutor_user_id', Auth::id());
    }

    if (request()->exists('filter') && !empty(request()->filter)) {
      $request = request();
      $value = '%' . $request->filter . '%';
      $inv = $inv->where(function ($query) use ($value) {
        $query->where('issue_auto_no', 'like', $value)
          ->orWhere('parties', 'like', $value)
          ->orWhere('prosecutors', 'like', $value)
          ->orWhere('secret_keeper', 'like', $value)
          ->orWhere('decisions', 'like', $value);
      });
    }
    if (request()->has('sort') && request()->sort) {
      list($sortCol, $sortDir) = explode('|', request()->sort);
      $inv = $inv->orderBy($sortCol, $sortDir);
    } else {
      $inv = $inv->orderBy('created_at', 'asc');
    }


    $investigations = $inv->paginate(10);
    foreach ($investigations as $investigation) {
      if (Cache::has('online-investigation-' . $investigation->id)) {
        $investigation->is_online = true;
      }
    }
    return json_encode($investigations);
  }

  public function create($issue_prosecutor_id)
  {
    $investigation = '';
    DB::transaction(function () use ($issue_prosecutor_id, &$investigation) {
      $opened_investigation = IssueProsecutor::where('id', $issue_prosecutor_id)->whereHas('investigations', function ($q) {
        return $q->where('is_closed', 0);
      });
      if ($opened_investigation->count()) {
        abort(403, 'لا يمكن إنشاء تحقيق جديد قبل إغلاق التحقيق السايق');
      }
      $investigation = Investigation::create([
        'issue_prosecutor_id' => $issue_prosecutor_id,
        'serial' => $this->generateInvestigationSerial($issue_prosecutor_id),
        'user_id' => Auth::id(),
        'started_on' => Carbon::now()->toDateString(),
        'started_at' => Carbon::now()->toTimeString(),
      ]);

      $users = IssueProsecutor::find($issue_prosecutor_id)->users;
      $status = '';
      $issue_prosecutor_user = IssueProsecutorUser::where([
        ['issue_prosecutor_id', $issue_prosecutor_id],
        ['user_id', Auth::id()]
      ])->first();
      if ($issue_prosecutor_user->status == '0' || $issue_prosecutor_user->status == '1' || $issue_prosecutor_user->status == '2') {
        $status = '1';
      } else {
        $status = '3';
      }
      foreach ($users as $user) {
        $user->issueProsecutors()->updateExistingPivot($issue_prosecutor_id, [
          'status' => $status,
        ]);
        if ($user->hasRole('وكيل النيابة')) {
          IssueProsecutorStatusLog::create([
            'status' => '1',
            'user_id' => $user->id,
            'issue_prosecutor_id' => $issue_prosecutor_id
          ]);
        }
      }
      $this->getAssigners(Auth::id(), $issue_prosecutor_id);
    });
    return $investigation;
  }

  public function storeAq(Request $request)
  {
    $InvestigationAq = null;

    if (request()->id) {
      $InvestigationAq = InvestigationAq::findOrFail(request()->id);
      $InvestigationAq->update([
        'question' => request()->question,
        'answer' => request()->answer,
        'note' => request()->note,
        'party_id' => request()->party_id,
        'investigation_id' => request()->investigation_id,
        'user_id' => request()->secretary_id
      ]);
    } else {
      $InvestigationAq = InvestigationAq::create([
        'question' => request()->question,
        'answer' => request()->answer,
        'note' => request()->note,
        'party_id' => request()->party_id,
        'investigation_id' => request()->investigation_id,
        'user_id' => request()->secretary_id
      ]);
    }
    $investigation = VInvestigation::find(request()->investigation_id);
    $prosecutor_name = $investigation->prosecutor_user_name;
    $prosecutor_id = $investigation->prosecutor_id;
    $party_name = Party::find(request()->party_id)->name;
    event(new AQBackEvent(request()->sender_id, $InvestigationAq, $prosecutor_name, $prosecutor_id, $party_name));
    event(new AQPartyBackEvent(request()->secret_key, $InvestigationAq));

    $users = User::whereHas('prosecutors', function ($query) use ($prosecutor_id) {
      $query->where('prosecutors.id', $prosecutor_id);
    })->get();

    foreach ($users as $user) {
      if ($user->can('الإطلاع على التحقيق') && !$user->hasRole('وكيل النيابة')) {
        event(new AQBackEvent($user->id, $InvestigationAq, $prosecutor_name, $prosecutor_id, $party_name));
      }
    }
    return InvestigationAq::where([
      ['user_id', request()->secretary_id],
      ['investigation_id', request()->investigation_id],
      ['party_id', request()->party_id]
    ])->latest()->get();
  }

  public function storeStatus(Request $request)
  {
    Validator::make($request->all(), [
      'status_id' => 'required',
    ], [
      'status_id.required' => 'يرجى إختيار حالة المتهم',
    ])->validate();

    InvestigationPartyAccusedStatus::where([
      'party_id' => request()->party_id,
      'investigation_id' => request()->investigation_id
    ])->delete();
    foreach (request()->status_id as $status) {
      InvestigationPartyAccusedStatus::updateOrCreate([
        'accused_status_id' => $status,
        'party_id' => request()->party_id,
        'investigation_id' => request()->investigation_id
      ]);
    }
  }

  public function getAqByInvestigationId($investigation_id, $party_id = null)
  {
    return InvestigationAq::with(['party', 'secretary', 'investigation.user'])->where('investigation_id', $investigation_id)->latest()->get();
  }

  public function sendInvestigationContent()
  {
    event(new InvestigationReportContentEvent(request()->investigation_id, request()->content));
  }


  public function startInvestigation()
  {
    if (request()->secretary_id !== 0) {
      if (!Cache::has('user-online-' . request()->secretary_id)) {
        abort(404, 'أمين السر غير متاح الآن');
      }
    }
    $investigation = null;


    DB::transaction(function () use (&$investigation) {
      $issue_prosecutor_id = request()->issue_prosecutor_id;
      $secretary_id = request()->secretary_id;
      $last_investigation = Investigation::where('issue_prosecutor_id', $issue_prosecutor_id)->latest()->first();
      $issue_prosecutor = IssueProsecutor::find(request()->issue_prosecutor_id);

      $users = $issue_prosecutor->users;
      $status = '';
      $issue_prosecutor_user = IssueProsecutorUser::where([
        ['issue_prosecutor_id', $issue_prosecutor_id],
        ['user_id', Auth::id()]
      ])->first();
      if ($issue_prosecutor_user->status == '0' || $issue_prosecutor_user->status == '1' || $issue_prosecutor_user->status == '2') {
        $status = '1';
      } else {
        $status = '3';
      }
      foreach ($users as $user) {
        $user->issueProsecutors()->updateExistingPivot(request()->issue_prosecutor_id, [
          'status' => $status,
        ]);
        if ($user->hasRole('وكيل النيابة')) {
          IssueProsecutorStatusLog::create([
            'status' => $status,
            'user_id' => $user->id,
            'issue_prosecutor_id' => request()->issue_prosecutor_id
          ]);
        }
      }

      $page_from = $last_investigation ? $last_investigation->end_page_no + 1 : 0;

      $investigation = Investigation::create([
        'issue_prosecutor_id' => $issue_prosecutor_id,
        'secretary_id' => $secretary_id !== 0 ? $secretary_id : null,
        'user_id' => Auth::id(),
        'start_page_no' => $page_from,
        'started_at' => Carbon::now(),
        'serial' => $this->generateInvestigationSerial($issue_prosecutor_id)
      ]);


      $investigation->sections()->create([
        'type' => 'head',
        'name' => 'ديباجة التحقيق',
        'order' => '1',
        'page_no_from' => $page_from,
        'content' => $this->generateReportHeader($investigation, false)
      ]);
      IssueProsecutorLog::create([
        'issue_prosecutor_id' => $issue_prosecutor->id,
        'action_by_id' => Auth::id(),
        'action_to_id' => null,
        'ref_id' => null,
        'data' => '',
        'current_action' => config()->get('constants.actions.create_investigation'),
        'created_at' => Carbon::now()
      ]);
      $investigation->load('sections');

      $expiresAt = Carbon::now()->addMinutes(5);
      Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

      if (request()->secretary_id !== 0) {
        event(new StartInvestigationEvent($investigation));
      }
      $managers = Prosecutor::find($investigation->issueProsecutor->prosecutor_id)->users()->role(['مدير النيابة', 'المحامي العام', 'مساعد المحامي العام', 'النائب العام', 'نائب مدير النيابة'])->get();
      foreach ($managers as $manager) {

        event(new NewInvestigationEvent($investigation, $manager->id));
        $manager->notify(new NewInvestigationNotification($investigation, $manager->id));
      }
    });

    return response()->json([
      'investigation' => $investigation,
    ]);
  }

  public function reassignInvestigation()
  {
    if (request()->secretary_id !== 0) {
      if (!Cache::has('user-online-' . request()->secretary_id)) {
        abort(404, 'أمين السر غير متاح الآن');
      }
    }
    $investigation = Investigation::find(request()->investigation_id);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    $investigation->update([
      'secretary_id' => request()->secretary_id
    ]);
    event(new StartInvestigationEvent($investigation));
    return response()->json([
      'investigation' => $investigation,
    ]);
  }

  public function printSection(InvestigationSection $investigation_section)
  {
    // $this->calcPages($investigation_section->investigation);
    // PDF::reset();
    $last_investigation = $investigation_section->investigation->issueProsecutor->investigations()->where('id', '!=', $investigation_section->investigation->id)->latest()->first();
    $start = $last_investigation ? $last_investigation->end_page_no  : 0;
    PDF::setRTL(true);

    PDF::setHeaderCallback(function ($pdf) {
      $pdf->SetY(15);
      $image_file = '/img/rep_logo.jpg';
      $pdf->Image($image_file, 120, 10, '', '', 'JPG', '', 'N', false, 300, 'C', false, false, 0, false, false, false);
      $pdf->SetFont('trado', 'B', 24);
      $pdf->writeHTMLCell('', '', 10, 50, '<p>محضر التحقيق</p>', 0, 0, 0, true, 'C', false, false, 0, false, false, false);
    });

    PDF::setFooterCallback(function ($pdf) use (&$start, $investigation_section) {
      $pdf->SetY(-18);
      $pdf->SetFont('trado', '', 12);
      $pdf->writeHTML('<p style="border-style: double!important; border-width: 3px!important; border-color: #000">&nbsp;</p>');
      $image_file = '/img/issues_barcode/' . $investigation_section->investigation->issueProsecutor->issue->issue_auto_no . '.png';
      $pdf->Image($image_file, 100, 280, '50', '', 'png', '', 'M', true, 300, 'C', false, false, 0, true, false, false);
      $pdf->Cell(0, 0, 'صفحة ' . ($pdf->PageNo() + $start), 0, 0, 'L', 0, '', 0, false, 'T', 'M');
    });

    PDF::setImageScale(PDF_IMAGE_SCALE_RATIO);
    PDF::SetFont('trado', '', 16);
    PDF::SetAuthor('System');
    PDF::SetTitle('');
    PDF::SetSubject('');
    PDF::SetMargins(10, 65, 10);
    PDF::SetFontSubsetting(true);

    PDF::AddPage('P', 'A4');

    //find if this aq is the first one in investigation aqs
    if ($investigation_section->type === 'aq') {
      $first_aq_note_section = $investigation_section->investigation->sections()->where('type', 'aq')->oldest()->first();
      if ($first_aq_note_section->id === $investigation_section->id) {
        foreach ($investigation_section->investigation->sections as $section) {
          PDF::writeHTML($section->content);
          if ($section->type === 'aq') {
            break;
          }
        }
      } else {
        $start = $investigation_section->page_no_from - 1;
        PDF::writeHTML($investigation_section->content);
      }
    } else if ($investigation_section->type === 'decisions') {
      IssueProsecutorLog::create([
        'issue_prosecutor_id' => $investigation_section->investigation->issue_prosecutor_id,
        'action_by_id' => Auth::id(),
        'action_to_id' => null,
        'ref_id' => null,
        'current_action' => config()->get('constants.actions.print_investigation_decisions'),
        'created_at' => Carbon::now()
      ]);
      $header = InvestigationSection::where('investigation_id', $investigation_section->investigation->id)
        ->where('type', 'head')->orderBy('order', 'desc')->first();
      $start = $investigation_section->page_no_from - 1;
      PDF::writeHTML($header->content);
      PDF::writeHTML($investigation_section->content);
    }
    PDF::Output('sec-' . $investigation_section->id . '-.pdf', 'I');
  }
  public function printTableOfContent(IssueProsecutor $issue_prosecutor)
  {
    $chapters = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر', 'الثالث عشر', 'الرابع عشر', 'الخامس عشر', 'السادس عشر', 'السابع عشر', 'الثامن عشر', 'التاسع عشر', 'العشرون'];
    PDF::setRTL(true);

    PDF::setHeaderCallback(function ($pdf) {
      $pdf->SetY(15);
      $image_file = '/img/rep_logo.jpg';
      $pdf->Image($image_file, 120, 10, '', '', 'JPG', '', 'N', false, 300, 'C', false, false, 0, false, false, false);
      $pdf->SetFont('trado', 'B', 24);
      $pdf->writeHTMLCell('', '', 10, 50, '<p>محضر التحقيق</p>', 0, 0, 0, true, 'C', false, false, 0, false, false, false);
    });

    PDF::setFooterCallback(function ($pdf) use (&$start, $issue_prosecutor) {
      //dd ($pdf);
      $pdf->SetY(-18);
      $pdf->SetFont('trado', '', 12);
      $pdf->writeHTML('<p style="border-style: double!important; border-width: 3px!important; border-color: #000">&nbsp;</p>');
      $image_file = '/img/issues_barcode/' . $issue_prosecutor->issue->issue_auto_no . '.png';
      $pdf->Image($image_file, 100, 280, '50', '', 'png', '', 'M', true, 300, 'C', false, false, 0, true, false, false);
      if ($pdf->tocpage != true) {
        $pdf->Cell(0, 0, 'صفحة ' . $pdf->getAliasNumPage(), 0, 0, 'L', 0, '', 0, false, 'T', 'M');
      }
    });

    PDF::setImageScale(PDF_IMAGE_SCALE_RATIO);
    PDF::SetFont('trado', '', 16);
    PDF::SetAuthor('System');
    PDF::SetTitle(' فهرس التحقيقات للقضية رقم: ' . $issue_prosecutor->issue->issue_no);
    PDF::SetSubject(' فهرس التحقيقات للقضية رقم: ' . $issue_prosecutor->issue->issue_no);
    PDF::SetMargins(10, 65, 10);
    PDF::SetFontSubsetting(false);
    // PDF::SetAutoPageBreak(true, PDF_MARGIN_BOTTOM);
    $investigations = $issue_prosecutor->investigations()->get();
    $index = 0;
    foreach ($investigations as $investigation) {
      PDF::AddPage('P', 'A4');
      PDF::Bookmark(' التحقيق ' . $chapters[$index], 0, -1, $investigation->start_page_no);
      $aq_note_list_count = $investigation->sections()->where('type', 'aq')->count();
      $current_aq_note_index = 1;
      // $section_index = 1;
      foreach ($investigation->sections as $section) {
        $html = '';
        if ($section->type === 'break') {
          PDF::AddPage('P', 'A4');
        } else {
          $page_start = $start;
          PDF::writeHTML($section->content);
        }
      }
      $index++;
    }

    PDF::addTOCPage('P', 'A4');
    PDF::SetMargins(10, 65, 10);
    PDF::SetFont('trado', 'B', 28);
    PDF::MultiCell(0, 0, 'فهرس التحقيقات', 0, 'C', 0, 1, '', '', true, 0);
    PDF::Ln();
    PDF::SetFont('trado', 'B', 16);

    PDF::addTOC(0, 'trado', '.', '');
    PDF::endTOCPage();
    PDF::Output('inv-all-' . $issue_prosecutor->id . '.pdf', 'I');
  }
  public function print(Investigation $investigation)
  {
    $last_investigation = $investigation->issueProsecutor->investigations()->where('id', '!=', $investigation->id)->latest()->first();
    $start = $last_investigation ? $last_investigation->end_page_no : 0;

    PDF::setRTL(true);

    PDF::setHeaderCallback(function ($pdf) {
      $pdf->SetY(15);
      $image_file = '/img/rep_logo.jpg';
      $pdf->Image($image_file, 120, 10, '', '', 'JPG', '', 'N', false, 300, 'C', false, false, 0, false, false, false);
      $pdf->SetFont('trado', 'B', 24);

      $pdf->writeHTMLCell('', '', 10, 50, '<p>محضر التحقيق</p>', 0, 0, 0, true, 'C', false, false, 0, false, false, false);
      //$pdf->writeHTMLCell('', '', 10, 50, '<p>بيانات التحقيق</p>', 0, 0, 0, true, 'C', false, false, 0, false, false, false);
    });

    PDF::setFooterCallback(function ($pdf) use (&$start, $investigation) {
      $pdf->SetY(-18);
      $pdf->SetFont('trado', '', 12);
      $pdf->writeHTML('<p style="border-style: double!important; border-width: 3px!important; border-color: #000">&nbsp;</p>');
      $image_file = '/img/issues_barcode/' . $investigation->issueProsecutor->issue->issue_auto_no . '.png';
      $pdf->Image($image_file, 100, 280, '50', '', 'png', '', 'M', true, 300, 'C', false, false, 0, true, false, false);
      $pdf->Cell(0, 0, 'صفحة ' . ($pdf->PageNo() + $start), 0, 0, 'L', 0, '', 0, false, 'T', 'M');
    });
    //PDF::setBarcode($investigation->issueProsecutor->issue->issue_auto_no);

    PDF::setImageScale(PDF_IMAGE_SCALE_RATIO);
    PDF::SetFont('trado', '', 16);
    PDF::SetAuthor('System');
    PDF::SetTitle('تقرير التحقيق رقم: ' . $investigation->serial);
    PDF::SetSubject('تقرير التحقيق رقم: ' . $investigation->serial);
    PDF::SetMargins(10, 65, 10);
    PDF::SetFontSubsetting(false);
    // PDF::SetAutoPageBreak(true, PDF_MARGIN_BOTTOM);

    PDF::AddPage('P', 'A4');
    $aq_note_list_count = $investigation->sections()->where('type', 'aq')->count();
    $current_aq_note_index = 1;
    // $section_index = 1;
    foreach ($investigation->sections as $section) {
      $html = '';

      if ($section->type === 'break') {
        PDF::AddPage('P', 'A4');
      } else {
        $page_start = PDF::PageNo() + $start;
        PDF::writeHTML($section->content);
        $section->update([
          'page_no_from' => $page_start,
          'page_no_to' => PDF::PageNo() + $start
        ]);
      }
    }
    $investigation->update([
      'start_page_no' => $start + 1,
      'end_page_no' => PDF::PageNo() + $start,
    ]);
    IssueProsecutorLog::create([
      'issue_prosecutor_id' => $investigation->issue_prosecutor_id,
      'action_to_id' => null,
      'action_by_id' => Auth::id(),
      'ref_id' => null,
      'current_action' => config()->get('constants.actions.print_investigation'),
      'created_at' => Carbon::now()
    ]);
    PDF::Output('inv-' . $investigation->id . '.pdf', 'I');
  }
  public function printInvestigation(Investigation $investigation)
  {

    $start = $investigation->start_page_no - 1;
    PDF::setRTL(true);
    PDF::setHeaderCallback(function ($pdf) {
      $pdf->SetY(15);
      $image_file = '/img/rep_logo.jpg';
      $pdf->Image($image_file, 120, 10, '', '', 'JPG', '', 'N', false, 300, 'C', false, false, 0, false, false, false);
      $pdf->SetFont('trado', 'B', 24);

      $pdf->writeHTMLCell('', '', 10, 50, '<p>محضر التحقيق</p>', 0, 0, 0, true, 'C', false, false, 0, false, false, false);
      //$pdf->writeHTMLCell('', '', 10, 50, '<p>بيانات التحقيق</p>', 0, 0, 0, true, 'C', false, false, 0, false, false, false);
    });

    PDF::setFooterCallback(function ($pdf) use (&$start, $investigation) {
      $pdf->SetY(-18);
      $pdf->SetFont('trado', '', 12);
      $pdf->writeHTML('<p style="border-style: double!important; border-width: 3px!important; border-color: #000">&nbsp;</p>');
      $image_file = '/img/issues_barcode/' . $investigation->issueProsecutor->issue->issue_auto_no . '.png';
      $pdf->Image($image_file, 100, 280, '50', '', 'png', '', 'M', true, 300, 'C', false, false, 0, true, false, false);
      $pdf->Cell(0, 0, 'صفحة ' . ($pdf->PageNo() + $start), 0, 0, 'L', 0, '', 0, false, 'T', 'M');
    });
    //PDF::setBarcode($investigation->issueProsecutor->issue->issue_auto_no);
    PDF::setImageScale(PDF_IMAGE_SCALE_RATIO);

    PDF::SetFont('trado', '', 16);
    PDF::SetAuthor('System');
    PDF::SetTitle('تقرير التحقيق رقم: ' . $investigation->serial);
    PDF::SetSubject('تقرير التحقيق رقم: ' . $investigation->serial);
    PDF::SetMargins(10, 65, 10);
    PDF::SetFontSubsetting(true);

    // PDF::SetAutoPageBreak(true, PDF_MARGIN_BOTTOM);

    PDF::AddPage('P', 'A4');
    $aq_note_list_count = $investigation->sections()->where('type', 'aq')->count();
    $current_aq_note_index = 1;
    // $section_index = 1;
    foreach ($investigation->sections as $section) {
      $html = '';
      if ($section->type === 'break') {
        PDF::AddPage('P', 'A4');
      } else {
        $page_start = PDF::PageNo() + $start;
        PDF::writeHTML($section->content);
        $section->update([
          'page_no_from' => $page_start,
          'page_no_to' => PDF::PageNo() + $start
        ]);
      }
    }
    $investigation->update([
      'start_page_no' => $start + 1,
      'end_page_no' => PDF::PageNo() + $start
    ]);
    IssueProsecutorLog::create([
      'issue_prosecutor_id' => $investigation->issue_prosecutor_id,
      'action_to_id' => null,
      'action_by_id' => Auth::id(),
      'ref_id' => null,
      'current_action' => config()->get('constants.actions.print_investigation'),
      'created_at' => Carbon::now()
    ]);
    PDF::Output('inv-' . $investigation->id . '.pdf', 'I');
  }
  public function calcPages(Investigation $investigation = null)
  {
    $last_investigation = null;
    if (!$investigation) {
      $investigation = Investigation::find(request()->investigationId);
      $last_investigation = $investigation->issueProsecutor->investigations()->where('id', '!=', request()->investigationId)->latest()->first();
    } else {
      $last_investigation = $investigation->issueProsecutor->investigations()->where('id', '!=', $investigation->id)->latest()->first();
    }
    $start = $last_investigation ? $last_investigation->end_page_no : 0;


    PDF::setRTL(true);

    PDF::setHeaderCallback(function ($pdf) {
      $pdf->SetY(15);
      $image_file = '/img/rep_logo.jpg';
      $pdf->Image($image_file, 120, 10, '', '', 'JPG', '', 'N', false, 300, 'C', false, false, 0, false, false, false);
      $pdf->SetFont('trado', 'B', 24);

      $pdf->writeHTMLCell('', '', 10, 50, '<p>محضر التحقيق</p>', 0, 0, 0, true, 'C', false, false, 0, false, false, false);
    });

    PDF::setFooterCallback(function ($pdf) use (&$start, $investigation) {
      $pdf->SetY(-18);
      $pdf->SetFont('trado', '', 12);
      $pdf->writeHTML('<p style="border-style: double!important; border-width: 3px!important; border-color: #000">&nbsp;</p>');
      $image_file = '/img/issues_barcode/' . $investigation->issueProsecutor->issue->issue_auto_no . '.png';
      $pdf->Image($image_file, 100, 280, '50', '', 'png', '', 'M', true, 300, 'C', false, false, 0, true, false, false);
      $pdf->Cell(0, 0, 'صفحة ' . ($pdf->PageNo() + $start), 0, 'L', 0, '', 0, false, 'T', 'M');
    });
    // PDF::setBarcode($investigation->issueProsecutor->issue->issue_auto_no);

    PDF::setImageScale(PDF_IMAGE_SCALE_RATIO);
    PDF::SetFont('trado', '', 16);
    PDF::SetAuthor('System');
    PDF::SetTitle('تقرير التحقيق رقم: ' . $investigation->serial);
    PDF::SetSubject('تقرير التحقيق رقم: ' . $investigation->serial);
    PDF::SetMargins(10, 65, 10);
    PDF::SetFontSubsetting(false);
    PDF::SetAutoPageBreak(true, PDF_MARGIN_BOTTOM);

    PDF::AddPage('P', 'A4');
    $aq_note_list_count = $investigation->sections()->where('type', 'aq')->count();
    $current_aq_note_index = 1;
    foreach ($investigation->sections as $section) {
      $html = '';

      if ($section->type === 'break') {
        PDF::AddPage('P', 'A4');
      } else {
        $page_start = PDF::PageNo() + $start;
        PDF::writeHTML($section->content);
        $section->update([
          'page_no_from' => $page_start,
          'page_no_to' => PDF::PageNo() + $start
        ]);
      }
    }
    $investigation->update([
      'start_page_no' => $start + 1,
      'end_page_no' => PDF::PageNo() + $start
    ]);
    PDF::Close();
  }

  public function sendDirectMessage(Request $request)
  {
    event(new DirectMessageEvent($request->user_id, $request->message));
  }

  public function storeDecisions(Request $request)
  {
    Validator::make($request->all(), [
      'decision_id' => 'required',
    ], [
      'decision_id.required' => 'يرجى إختيار القرار',
    ])->validate();
    $investigation = Investigation::findOrFail(request()->investigation_id);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    $investigation->decisions()->sync(request()->decision_id);
  }

  public function aqSessionStart($secretary_id, $party_id, $investigation_id)
  {
    $party = Party::findOrFail($party_id);

    if ($party->is_anonymous) {
      abort(403, 'لا يمكن التحقيق مع مجهول، الرجاء إستكمال بيانات الطرف.');
    }

    if ((!$party->passport_no && !$party->civil_no) || !$party->name) {
      abort(403, ' الرجاء إستكمال بيانات الطرف.');
    }

    InvestigationAq::whereNull('question')->orWhereNull('answer')->delete();

    $data = [];
    $channel_secret_key = $this->generateRandomCode(10);
    $expiresAt = Carbon::now()->addHours(8);
    Cache::add($channel_secret_key, $investigation_id, $expiresAt);
    Cache::add('online-investigation-' . $investigation_id, request()->investigation_id, $expiresAt);
    $investigation_session = InvestigationSession::where('investigation_id', request()->investigation_id)->latest()->first();

    if (!$investigation_session || $investigation_session->party_id != request()->party_id) {
      $investigation_session = InvestigationSession::create([
        'party_id' => request()->party_id,
        'investigation_id' => request()->investigation_id,
        'user_id' => Auth::id()
      ]);
    }
    $investigation_aq = $investigation_session->aqs()->create();

    event(new AQChannelEvent($secretary_id, $party_id, $investigation_id, $channel_secret_key, $investigation_aq->id, $investigation_aq->investigation_session_id));

    $investigationsAqNote = VInvestigationAqNote::whereHas('investigationSession', function ($q) {
      $q->where('party_id', request()->party_id)->where('investigation_id', request()->investigation_id);
    })->oldest()->get();

    array_push(
      $data,
      ['channel_secret_key' => $channel_secret_key],
      ['aqs' => $investigationsAqNote],
      ['aq_id' => $investigation_aq->id],
      ['party_name' => $party->name]
    );
    return $data;
  }

  private function generateInvestigationSerial($issue_prosecutor_id)
  {
    $investigation = Investigation::where('issue_prosecutor_id', $issue_prosecutor_id)->orderBy('serial', 'desc')->first();
    if ($investigation) {
      return $investigation->serial + 1;
    }
    return 1;
  }

  public function editAQ($id)
  {
    return InvestigationAq::findOrFail($id);
  }

  public function partySecretaryEdit()
  {
    $party = VParty::where('id', request()->party_id)->get()->first();
    event(new PartySecretaryEditEvent($party, request()->secretary_id));
    return $party;
  }

  public function updateAQ()
  {
    $investigation_aq = InvestigationAq::findOrFail(request()->aq_id);
    $investigation_aq->update([
      'question' => request()->question,
      'answer' => request()->answer,
    ]);
    event(new AQUpdateEvent($investigation_aq, request()->investigation_id));
    return $investigation_aq;
  }

  public function createNote()
  {
    InvestigationAq::whereNull('question')->orWhereNull('answer')->delete();

    $investigation_session = InvestigationSession::find(request()->session_id);
    $investigation_note = $investigation_session->notes()->create([
      'note' => request()->note,
    ]);

    $aq = $investigation_session->aqs()->create([
      'investigation_session_id' => request()->session_id,
    ]);

    event(new NoteCreateEvent($investigation_note, request()->investigation_id, $aq->id));
  }

  public function createAQ()
  {
    $investigation_session = InvestigationSession::find(request()->session_id);
    $investigation_aq = $investigation_session->aqs()->create([
      'investigation_session_id' => request()->session_id,
      'question' => request()->question,
      'answer' => request()->answer
    ]);
    event(new AQCreateEvent($investigation_aq, request()->investigation_id));

    $aqs = InvestigationAq::whereHas('session', function ($query) {
      $query->where('party_id', request()->party_id);
    })->oldest()->get();

    return [
      'investigation_aq' => $investigation_aq,
      'aqs' => $aqs
    ];
  }

  public function sendAQ()
  {
    event(new AQSendEvent(request()->investigation_id, request()->question, request()->answer, request()->sender, request()->aq_id));
  }

  public function deleteInvestigationSection()
  {
    InvestigationSection::destroy(request()->section_id);
    $investigation = Investigation::findOrFail(request()->investigation_id)->load('sections');

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    if ($investigation->secretary_id) {
      event(new UpdateInvestigationEvent($investigation, request()->is_secretary));
    }
    $investigation->load(['sections' => function ($query) {
      $query->orderBy('order', 'asc');
    }]);
    return response()->json([
      'investigation' => $investigation
    ]);
  }

  private function generateAqNote($aqNoteList, $issue_id, $is_last = false)
  {
    Carbon::setLocale('ar');
    $html = '<table style="border: 1px solid #d5d9dc; width:100%; background-color: #fff; border-collapse: collapse;" cellpadding="5" dir="rtl">';
    $html .= '<tbody>';
    $party = $aqNoteList->first()->party;

    if ($party->person_type === '1') {
      $html .= '<tr  style="page-break-inside: avoid">';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>إسمي:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . $party->name . '</td>';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>عمري:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . ($party->birth_date ? Carbon::parse($party->birth_date)->diffInYears(Carbon::now()) : '') . '</td>';
      $html .= '</tr>';
      $html .= '<tr  style="page-break-inside: avoid">';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>جنسيتي:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . ($party->nationality ? $party->nationality->title : '') . '</td>';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>أعمل:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . $party->job . '</td>';
      $html .= '</tr>';
      $html .= '<tr  style="page-break-inside: avoid">';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>مقيم في:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . $this->getAddress($party) . '</td>';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>التليفون:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . $party->mobile . '</td>';
      $html .= '</tr>';
      $html .= '<tr  style="page-break-inside: avoid">';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>رقم الإثبات:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . $this->getIdentity($party) . '</td>';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>الجنس:</b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . $this->getGender($party) . '</td>';
      $html .= '</tr>';
    } else {
      $html .= '<tr  style="page-break-inside: avoid">';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>الإسم الاعتباري:
      </b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . $party->name . '</td>';
      $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6;"><b>المنطقة:
      </b></td>';
      $html .= '  <td style="width: 35%; border: 1px solid #d5d9dc; padding: 10px;">' . ($party->destination ? $party->destination->name : '') . '</td>';
      $html .= '</tr>';
    }
    switch ($party->issues()->where('issues.id', $issue_id)->first()->pivot->type) {
      case '1':
        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; background-color:#dee2e6; text-align:center" colspan="4">';
        $html .= '      <span style="font-size:22px">حلف اليمين</span>';
        $html .= '  </td>';
        $html .= '</tr>';
        break;
      case '3':
        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; background-color:#dee2e6; text-align:center" colspan="4">';
        $html .= '      <span style="font-size:22px">حلف اليمين</span>';
        $html .= '  </td>';
        $html .= '</tr>';
        break;
      case '4':
        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; background-color:#dee2e6; text-align:center" colspan="4">';
        $html .= '      <span style="font-size:22px">حلف اليمين</span>';
        $html .= '  </td>';
        $html .= '</tr>';
        break;
      case '5':
        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; background-color:#dee2e6; text-align:center" colspan="4">';
        $html .= '      <span style="font-size:22px">سئل على سبيل الاستدلال</span>';
        $html .= '  </td>';
        $html .= '</tr>';
        break;
      case '6':
        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; background-color:#dee2e6; text-align:center" colspan="4">';
        $html .= '      <span style="font-size:22px">سئل على سبيل الاستئناس</span>';
        $html .= '  </td>';
        $html .= '</tr>';
        break;
    }
    $html .= ' </tbody>';
    $html .= '</table>';
    $html .= '<table style="border: 1px solid #d5d9dc; width:100%; background-color: #fff; border-collapse: collapse; margin-top: 50px" cellpadding="5" dir="rtl">';
    $html .= '<tbody>';

    foreach ($aqNoteList as $item) {
      if ($item->type === 'aq') {
        $aq = $item->aq;

        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#f4f4f5; padding:10px "><b> س' . $aq->order .
          '</b></td>';
        $html .= '  <td style="border: 1px solid #d5d9dc; width:85%; background-color:#f4f4f5"><b>' . $aq->question . '</b></td>';
        $html .= '</tr>';
        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; padding:10px "><b> ج' . $aq->order .
          '</b></td>';
        $html .= '  <td style="border: 1px solid #d5d9dc; width:85%;">' . $aq->answer . '</td>';
        $html .= '</tr>';
      } else {
        $note = $item->note;

        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td style="border: 1px solid #d5d9dc; width:15%; background-color:#dee2e6; padding:10px "><b> ملحوظة' . $note->order .
          '</b></td>';
        $html .= '  <td style="border: 1px solid #d5d9dc; width:85%">' . $note->note . '</td>';
        $html .= '</tr>';
        $html .= '<tr  style="page-break-inside: avoid">';
        $html .= '  <td colspan="2" style="border: 1px solid #d5d9dc; width:15%; padding:10px "><b>تمت الملحوظة</b></td>';
        $html .= '  <td style="border: 1px solid #d5d9dc; width:85%">';
        $html .= '      عضو النيابة<br><img width="200px" src="/img/sign.jpg">';
        $html .= '  </td>';
        $html .= '</tr>';
      }
    }
    $html .= ' </tbody>';
    $html .= '</table>';
    $html .= '<table style="border: 1px solid #d5d9dc; width:100%; background-color: #fff; border-collapse: collapse;" cellpadding="5" dir="rtl">';
    $html .= '<tbody>';
    $html .= '  <tr  style="page-break-inside: avoid"><td style="width: 10%"></td><td style="width: 80%"></td><td style="width: 10%"></td></tr>';
    $html .= '  <tr  style="page-break-inside: avoid">';
    $html .= '      <td></td>';
    $html .= '      <td style="text-align:right;">و تمت أقواله ووقع عليها في يوم ' . Carbon::now()->toDateString() . ' في تمام الساعة ' . Carbon::now()->format('h:i:s A') . '</td>';
    $html .= '      <td></td>';
    $html .= '  </tr>';
    $html .= ' </tbody>';
    $html .= '</table>';
    if (request()->hasTranslator) {
      $html .= '<table style="border: 1px solid #d5d9dc; width:100%; background-color: #fff; border-collapse: collapse;" cellpadding="5" dir="rtl">';
      $html .= '  <tr style="page-break-inside: avoid">';
      $html .= '    <td style="width: 33%"><p>الإسم</p><br><img width="200px" src="/img/sign.jpg"></td>';
      $html .= '    <td style="width: 33%"><p>المترجم</p><br><img width="200px" src="/img/sign.jpg"></td>';
      $html .= '    <td style="width: 34%"><p>عضو النيابة</p><br><img width="200px" src="/img/sign.jpg"></td>';
      $html .= '   </tr>';
      $html .= '</table>';
    } else {
      $html .= '<table style="border: 1px solid #d5d9dc; width:100%; background-color: #fff; border-collapse: collapse;" cellpadding="5" dir="rtl">';
      $html .= '  <tr style="page-break-inside: avoid">';
      $html .= '    <td style="width: 5%"></td>';
      $html .= '    <td style="width: 45%"><p>الإسم</p><br><img width="200px" src="/img/sign.jpg"></td>';
      $html .= '    <td style="width: 45%"><p>عضو النيابة</p><br><img width="200px" src="/img/sign.jpg"></td>';
      $html .= '    <td style="width: 5%"></td>';
      $html .= '   </tr>';
      $html .= '</table>';
    }
    $html .= '<table style="width:100%; background-color: #fff; border-collapse: collapse;" cellpadding="5" dir="rtl">';
    $html .= '<tbody>';
    // $html .= '  <tr  style="page-break-inside: avoid"><td ></td><td style="width: 80%"></td><td style="width: 10%"></td></tr>';
    $html .= '  <tr  style="page-break-inside: avoid">';
    $html .= '      <td style="width: 10%"></td>';
    if ($is_last) {
      $html .= '      <td style="text-align:center; width: 80%">نهاية التحقيق والقرارات في الصفحة التالية</td>';
    } else {
      $html .= '      <td style="text-align:center; width: 80%">نهاية التحقيق والطرف التالي في الصفحة التالية</td>';
    }
    $html .= '      <td style="width: 10%"></td>';
    $html .= '  </tr>';
    $html .= ' </tbody>';
    $html .= '</table>';
    return $html;
  }

  private function generateReportHeader($investigation, $with_close)
  {
    $accusations_array = [];
    foreach ($investigation->issueProsecutor->issue->parties as $party) {
      if ($party->accusations->count()) {
        foreach ($party->accusations as $accusation) {
          if (!array_has($accusations_array, $accusation->name)) {
            array_push($accusations_array, $accusation->name);
          }
        }
      }
    }
    $accusations = '';
    if (count($accusations_array)) {
      $accusations = '<ul>';
      foreach ($accusations_array as $accusation) {
        $accusations .= "<li> {$accusation} </li>";
      }
      $accusations .= '</ul>';
    }

    $html = '<table style="border: 1px solid #d5d9dc; width:100%; background-color: #fff; border-collapse: collapse;" cellpadding="5" dir="rtl">';
    $html .= '  <tbody>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>الرقم الآلي للقضية:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . $investigation->issueProsecutor->issue->issue_auto_no . '</td>';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>عضو النيابة:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . $investigation->user->name . '</td>';
    $html .= '      </tr>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>رقم القضية:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . $investigation->issueProsecutor->issue->issue_no . '</td>';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>أمين السر:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . ($investigation->secretary ? $investigation->secretary->name : 'بدون أمين سر') . '</td>';
    $html .= '      </tr>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>رقم الحصر:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . $investigation->issueProsecutor->issue->issue_exclusive_no . '</td>';
    $html .= '          <td rowspan="2" style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>التهم:</b></td>';
    $html .= '          <td rowspan="2" style="width: 30%; border: 1px solid #d5d9dc;">' . $accusations . '</td>';
    $html .= '      </tr>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>تاريخ التحقيق:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . Carbon::parse($investigation->started_at)->toDateString() . '</td>';
    $html .= '      </tr>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>وقت بداية التحقيق:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . Carbon::parse($investigation->started_at)->toTimeString() . '</td>';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>وقت نهاية التحقيق:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . ($with_close ? Carbon::parse($investigation->closed_at)->toTimeString() : '') . '</td>';
    $html .= '      </tr>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>رقم المخفر:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . $investigation->issueProsecutor->issue->station_no . '</td>';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>مسلسل التحقيق:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . $investigation->serial . '</td>';
    $html .= '      </tr>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b>النيابة:</b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;">' . $investigation->issueProsecutor->prosecutor->name . '</td>';
    $html .= '          <td style="border: 1px solid #d5d9dc; width:20%; background-color:#dee2e6; padding: 10px;"><b></b></td>';
    $html .= '          <td style="width: 30%; border: 1px solid #d5d9dc; padding: 10px;"></td>';
    $html .= '      </tr>';
    $html .= '      <tr  style="page-break-inside: avoid">';
    $html .= '          <td style="border: 1px solid #d5d9dc; background-color:#dee2e6; text-align:center" colspan="4">';
    $html .= '               <span style="font-size:22px">بيانات التحقيق</span>';
    $html .= '          </td>';
    $html .= '      </tr>';
    $html .= '  </tbody>';
    $html .= '</table>';

    return $html;
  }

  private function generateReportDecisions($investigation)
  {
    $html = '<p>وأقفل المحضر عقب إثبات ما تقدم وقررنا التالي</p>';
    $html .= request()->template_content;
    $html .= '<table style="border: 1px solid #d5d9dc; width:100%; background-color: #fff; border-collapse: collapse;" cellpadding="5" dir="rtl">';
    $html .= '<tbody>';
    $html .= '  <tr  style="page-break-inside: avoid">';
    $html .= '      <td style="width: 10%"></td>';
    $html .= '      <td style="width:30%;">';
    if ($investigation->secretary_id) {
      $html .= '          <p>أمين السر</p>';
      $html .= '          <img width="200px" src="/img/sign.jpg">';
    }
    $html .= '      </td>';
    $html .= '      <td style="width: 20%"></td>';
    $html .= '      <td style="width: 30%">';
    $html .= '           <p>عضو النيابة</p>';
    $html .= '           <img width="200px" src="/img/sign.jpg">';
    $html .= '      </td>';
    $html .= '      <td style="width: 10%"></td>';
    $html .= '   </tr>';
    $html .= '   <tr  style="page-break-inside: avoid"><td colspan="5" style="width: 100%; text-align:center"><p>نهاية التحقيق والقرارات</p></td></tr>';
    $html .= ' </tbody>';
    $html .= '</table>';

    return $html;
  }

  public function buildInvestigationReportHeader($with_close = false)
  {
    $investigation = Investigation::findOrFail(request()->investigation_id);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);
    $inv_sections = $investigation->sections();
    $order = $inv_sections->count() ? $inv_sections->orderBy('order', 'desc')->first()->order : 0;
    $investigation->sections()->create([
      'content' => $this->generateReportHeader($investigation, $with_close),
      'type' => 'head',
      'name' => 'ديباجة التحقيق',
      'order' => $order + 1
    ]);
    if ($investigation->secretary_id) {
      event(new UpdateInvestigationEvent($investigation, request()->is_secretary));
    }
    $investigation->load(['sections' => function ($query) {
      $query->orderBy('order', 'asc');
    }]);
    return response()->json([
      'investigation' => $investigation
    ]);
  }

  public function buildInvestigationReportBreak()
  {
    $investigation = Investigation::findOrFail(request()->investigation_id);
    $inv_sections = $investigation->sections();
    $order = $inv_sections->count() ? $inv_sections->orderBy('order', 'desc')->first()->order : 0;
    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    $investigation->sections()->create([
      'type' => 'break',
      'name' => 'صفحة جديده',
      'order' => $order + 1
    ]);

    $investigation->load(['sections' => function ($query) {
      $query->orderBy('order', 'asc');
    }]);
    if ($investigation->secretary_id) {
      event(new UpdateInvestigationEvent($investigation, request()->is_secretary));
    }

    return response()->json([
      'investigation' => $investigation
    ]);
  }

  public function buildInvestigationReportTemplate(Request $request)
  {
    $investigation = Investigation::findOrFail($request->investigation_id);
    $inv_sections = $investigation->sections();
    $order = $inv_sections->count() ? $inv_sections->orderBy('order', 'desc')->first()->order : 0;
    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    $investigation->sections()->create([
      'type' => 'template',
      'content' => $request->content,
      'name' => 'إختصار (' . $request->name . ')',
      'order' => $order + 1
    ]);
    $investigation->load(['sections' => function ($query) {
      $query->orderBy('order', 'asc');
    }]);
    if ($investigation->secretary_id) {
      event(new UpdateInvestigationEvent($investigation, $request->is_secretary));
    }
    return response()->json([
      'investigation' => $investigation,
    ]);
  }

  public function buildInvestigationReportDecisions()
  {
    $investigation = null;
    $section = null;
    DB::transaction(function () use (&$investigation, &$section) {
      $investigation = Investigation::findOrFail(request()->investigation_id);
      $inv_sections = $investigation->sections();
      $order = $inv_sections->count() ? $inv_sections->orderBy('order', 'desc')->first()->order : 0;
      $expiresAt = Carbon::now()->addMinutes(5);
      Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

      $investigation->update([
        'closed_at' => Carbon::now()
      ]);

      $this->buildInvestigationReportHeader(true);
      $section = $investigation->sections()->create([
        'type' => 'decisions',
        'name' => 'القرارات',
        'order' => $order + 1
      ]);

      $section->decisions()->attach(request()->decisions_ids);

      if (request()->has('defendant_id') && request()->has('accused_status_ids')) {
        foreach (request()->accused_status_ids as $id) {
          $section->accuseStatuses()->create([
            'party_id' => request()->defendant_id,
            'accused_status_id' => $id
          ]);
        }
      }
      if ($investigation->secretary_id) {
        event(new UpdateInvestigationEvent($investigation, request()->is_secretary));
      }
    });

    $section->update([
      'content' => $this->generateReportDecisions($investigation, request()->template_content)
    ]);
    $investigation->load(['sections' => function ($query) {
      $query->orderBy('order', 'asc');
    }]);
    return response()->json([
      'investigation' => $investigation,
    ]);
  }


  public function buildInvestigationReportAQ()
  {
    $party = Party::find(request()->party_id);
    $investigation = Investigation::findOrFail(request()->investigation_id);
    $inv_sections = $investigation->sections();
    $order = $inv_sections->count() ? $inv_sections->orderBy('order', 'desc')->first()->order : 0;
    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    $section = $investigation->sections()->create([
      'type' => 'aq',
      'content' => '',
      'name' => 'التحقيق مع  (' . $party->name . ')',
      'ref_id' => $party->id,
      'order' => $order + 1
    ]);
    $access_token = $this->generateRandomString();
    $payload = [
      'section' => $section,
      'party' => $party
    ];
    Cache::add($access_token, $payload, Carbon::now()->addHours(5));

    event(new UpdateInvestigationEvent($investigation, request()->is_secretary));
    event(new AQStartEvent($investigation, $party, $section->id, request()->is_secretary));
    event(new AdminAQStartEvent($investigation, $party, $section->id));
    $investigation->load(['sections' => function ($query) {
      $query->orderBy('order', 'asc');
    }]);
    $this->buildInvestigationReportBreak();
    return response()->json([
      'investigation' => $investigation,
      'section' => $section,
      'party' => $party,
      'access_token' => $access_token
    ]);
  }

  public function updateInvestigationReportTemplate(Request $request)
  {
    $section = InvestigationSection::findOrFail($request->section_id);
    $section->update([
      'content' => $request->content,
    ]);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $section->investigation->id, true, $expiresAt);

    $section->investigation->load('sections');
    if ($section->investigation->secretary_id) {
      event(new UpdateInvestigationEvent($section->investigation, $request->is_secretary));
    }
    return response()->json([
      'investigation' => $section->investigation,
    ]);
  }
  public function updateInvestigationDecisionReportTemplate(Request $request)
  {
    $section = InvestigationSection::findOrFail($request->section_id);
    $section->update([
      'content' => $request->content,
    ]);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $section->investigation->id, true, $expiresAt);

    $section->investigation->load('sections');
    if ($section->investigation->secretary_id) {
      event(new UpdateInvestigationEvent($section->investigation, $request->is_secretary));
    }
    return response()->json([
      'investigation' => $section->investigation,
    ]);
  }

  public function getTemplateContent()
  {
    $template = Template::find(request()->template_id);
    $investigation = Investigation::find(request()->investigation_id);

    event(new StartTemplateEvent($investigation, request()->is_secretary, $template));

    return response()->json([
      'content' => $template->template,
      'template_name' => $template->name
    ]);
  }
  public function openTemplateContent()
  {
    $section = InvestigationSection::find(request()->section_id);
    event(new StartTemplateEvent($section->investigation, request()->is_secretary, $section->content, request()->section_id));
  }
  public function closeTemplateContent()
  {
    $investigation = Investigation::find(request()->investigation_id);
    event(new CloseTemplateEvent($investigation, request()->is_secretary));
  }
  public function getSectionTemplateContent(InvestigationSection $section)
  {
    return response()->json([
      'content' => $section->content
    ]);
  }

  public function investigationValidation(Investigation $investigation)
  {
    if (!$investigation) {
      abort(404, 'لا يوجد تحقيق');
    }
  }

  public function prosecutorsInvestigationValidation(IssueProsecutor $issue_prosecutor)
  {
    $opened_investigations = $issue_prosecutor->investigations()->where('is_closed', false)->get();
    if ($opened_investigations->count()) {
      abort(404, 'لا يوجد تحقيق');
    }
  }

  public function openAq()
  {
    event(new AQOpenEvent(request()->investigation_id));
  }

  public function closeAq()
  {
    event(new AQCloseEvent(request()->investigation_id));
  }

  public function openNote()
  {
    event(new NoteOpenEvent(request()->investigation_id));
  }

  public function closeNote()
  {
    event(new NoteCloseEvent(request()->investigation_id));
  }

  public function saveNote()
  {
    $section = null;

    DB::transaction(function () use (&$section) {
      $section = InvestigationSection::find(request()->section_id);

      if (request()->id) {
        InvestigationAqNote::find(request()->id)->note()->update([
          'note' => request()->note,
        ]);
      } else {
        $order = $section->aq_notes->count() ? $section->aq_notes()->orderBy('order', 'desc')->first()->order : 0;

        $note = InvestigationNote::whereHas('aq_note', function ($q) use ($section) {
          $q->where('investigation_section_id', $section->id);
        })->orderBy('order', 'desc')->first();

        $note_order = $note ? $note->order : 0;

        $aq_note = $section->aq_notes()->create([
          'party_id' => request()->party_id,
          'secretary_id' => request()->secretary_id,
          'type' => 'note',
          'order' => $order + 1
        ]);
        $new_note = new InvestigationNote();
        $new_note->id = $aq_note->id;
        $new_note->order = $note_order + 1;
        $new_note->note = request()->note;

        $new_note->save();
      }
      $section->investigation->load('sections');

      $expiresAt = Carbon::now()->addMinutes(5);
      Cache::add('online-investigation-' . $section->investigation->id, true, $expiresAt);

      event(new NoteCreatedEvent($section));
    });

    return response()->json([
      'investigation' => $section->investigation
    ]);
  }

  public function saveAq()
  {
    $section = null;
    $investigation = null;

    DB::transaction(function () use (&$section) {
      $section = InvestigationSection::find(request()->section_id);

      if (request()->id) {
        InvestigationAqNote::find(request()->id)->aq()->update([
          'question' => request()->q,
          'answer' => request()->a,
        ]);
      } else {
        $order = $section->aq_notes->count() ? $section->aq_notes()->orderBy('order', 'desc')->first()->order : 0;

        $aq = InvestigationAq::whereHas('aq_note', function ($q) use ($section) {
          $q->where('investigation_section_id', $section->id);
        })->orderBy('order', 'desc')->first();

        $aq_order = $aq ? $aq->order : 0;

        $aq_note = $section->aq_notes()->create([
          'party_id' => request()->party_id,
          'secretary_id' => request()->secretary_id,
          'type' => 'aq',
          'order' => $order + 1
        ]);
        $aq_note->aq()->create([
          'question' => request()->q,
          'answer' => request()->a,
          'order' => $aq_order + 1
        ]);
      }
      $section->investigation->load('sections');

      $expiresAt = Carbon::now()->addMinutes(5);
      Cache::add('online-investigation-' . $section->investigation->id, true, $expiresAt);

      event(new AQCreatedEvent($section));
    });

    return response()->json([
      'investigation' => $section->investigation
    ]);
  }

  public function addAqNoteSectionContent()
  {
    $section = InvestigationSection::find(request()->section_id);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $section->investigation->id, true, $expiresAt);

    $aq_note_list = $section->aq_notes()->get();
    if ($aq_note_list->count()) {
      $section->update([
        'content' => $this->generateAqNote($aq_note_list, $section->investigation->issueProsecutor->issue->id, request()->is_last),
      ]);
    }
    Cache::forget(request()->access_token);
    event(new AQNoteCreateSectionContentEvent($section->investigation));
    event(new AdminAQNoteCreateSectionContentEvent($section->investigation));

    return response()->json([
      'investigation' => $section->investigation
    ]);
  }

  public function getAqNoteViewContent(InvestigationAqNote $investigation_aq_note)
  {
    if ($investigation_aq_note->type === 'aq') {
      return response()->json([
        'question' => $investigation_aq_note->aq->question,
        'answer' => $investigation_aq_note->aq->answer,
      ]);
    } else {
      return response()->json([
        'note' => $investigation_aq_note->note->note,
      ]);
    }
  }

  public function editAqNoteSection()
  {
    $section = InvestigationSection::with('aq_notes')->find(request()->section_id);
    $party = Party::find($section->ref_id);
    $investigation = $section->investigation;

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    $access_token = $this->generateRandomString();

    $payload = [
      'section' => $section,
      'party' => $party
    ];
    Cache::add($access_token, $payload, Carbon::now()->addHours(5));

    event(new AQStartEvent($investigation, $party, request()->section_id, request()->is_secretary));
    event(new AdminAQStartEvent($investigation, $party, $section->id));
    return response()->json([
      'investigation' => $investigation,
      'party' => $party,
      'section' => $section,
      'access_token' => $access_token
    ]);
  }

  public function aqNoteOrderUpdate()
  {
    $section = InvestigationSection::find(request()->section_id);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $section->investigation->id, true, $expiresAt);


    foreach (request()->aq_note_list as $item) {
      $investigation_aq_note = InvestigationAqNote::find($item['id']);
      $investigation_aq_note->update([
        'order' => $item['order']
      ]);
      if ($item['type'] === 'aq') {
        $investigation_aq_note->aq()->update([
          'order' => $item['aq']['order']
        ]);
      } else {
        $investigation_aq_note->note()->update([
          'order' => $item['note']['order']
        ]);
      }
    }

    event(new AQNoteListUpdatedEvent($section->investigation, request()->is_secretary));
    event(new AdminAQNoteListUpdatedEvent($section->investigation));

    return response()->json([
      'investigation' => $section->investigation,
      'aq_note_list' => $section->aq_notes,
    ]);
  }
  public function sectionsOrderUpdate()
  {
    $investigation = Investigation::find(request()->investigation_id);

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);


    foreach (request()->sections_list as $item) {
      $section = InvestigationSection::find($item['id']);
      $section->update([
        'order' => $item['order']
      ]);
    }
    $investigation->load(['sections' => function ($query) {
      $query->orderBy('order', 'asc');
    }]);
    event(new SectionsListUpdatedEvent($investigation, request()->is_secretary));
    //  event(new AdminSectionsListUpdatedEvent($investigation));

    return response()->json([
      'investigation' => $investigation
    ]);
  }

  public function aqMessage()
  {
    $investigation = Investigation::find(request()->investigation_id);
    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    event(new AQSendEvent($investigation, request()->question, request()->answer));
  }

  public function noteMessage()
  {
    $investigation = Investigation::find(request()->investigation_id);
    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    event(new NoteSendEvent($investigation, request()->note));
  }
  public function templateMessage()
  {
    $investigation = Investigation::find(request()->investigation_id);
    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    event(new TemplateSendEvent($investigation, request()->content, request()->is_secretary));
  }

  public function partiesUpdate()
  {
    $investigation = Investigation::find(request()->investigation_id);
    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $investigation->id, true, $expiresAt);

    $parties = $investigation->issueProsecutor->issue->parties()->select('parties.id as value', 'name as label')->orderBy('name')->get();
    if ($investigation->secretary_id) {
      event(new PartiesUpdateEvent($investigation, $parties->toArray(), request()->is_secretary));
    }
    return response()->json([
      'investigation' => $investigation,
      'parties' => $parties
    ]);
  }

  public function deleteAqNote()
  {
    $aq_note = InvestigationAqNote::with('section')->find(request()->id);
    $section = $aq_note->section;

    $expiresAt = Carbon::now()->addMinutes(5);
    Cache::add('online-investigation-' . $section->investigation->id, true, $expiresAt);


    $aq_note->delete();
    $section->load('aq_notes');
    if ($aq_note->type === 'aq') {
      $aq_list = InvestigationAqNote::with('aq')->where('investigation_section_id', $section->id)->where('type', 'aq')->get();
      $order = 1;
      foreach ($aq_list as $item) {
        $item->aq()->update([
          'order' => $order
        ]);
        $order++;
      }
    } else {
      $note_list = InvestigationAqNote::with('note')->where('investigation_section_id', $section->id)->where('type', 'note')->get();
      $order = 1;
      foreach ($note_list as $item) {
        $item->note()->update([
          'order' => $order
        ]);
        $order++;
      }
    }

    event(new AQNoteListUpdatedEvent($section->investigation, request()->is_secretary));
    event(new AdminAQNoteListUpdatedEvent($section->investigation));

    return response()->json([
      'investigation' => Investigation::find(request()->investigationId),
      'section' => $section
    ]);
  }

  public function getInvestigationById(Investigation $investigation)
  {
    return response()->json([
      'investigation' => $investigation
    ]);
  }

  private function getIdentity($party)
  {
    if ($party->civil_no) {
      return 'رقم مدني/' . $party->civil_no;
    } elseif ($party->passport_no) {
      return 'جواز سفر/' . $party->passport_no;
    } elseif ($party->unified_no) {
      return 'رقم موحد/' . $party->unified_no;
    } else {
      return '';
    }
  }

  private function getGender($party)
  {
    if ($party->gender === '1') {
      return 'ذكر';
    } elseif ($party->gender === '2') {
      return 'أنثى';
    } elseif ($party->gender === '3') {
      return 'مجهول';
    } elseif ($party->gender === '4') {
      return 'غير مبين';
    } else {
      return '';
    }
  }

  public function sessionValidate()
  {
    $access_token = request()->access_token;
    if (Cache::has($access_token)) {
      $payload = Cache::get($access_token);
      return response()->json($payload);
    } else {
      abort(404, 'كود الوصول غير صحيح');
    }
  }

  private function generateRandomString($length = 6)
  {
    $characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    $charactersLength = strlen($characters);
    $randomString = '';
    for ($i = 0; $i < $length; $i++) {
      $randomString .= $characters[rand(0, $charactersLength - 1)];
    }
    return $randomString;
  }
  public function getInvestigationDecisions()
  {

    $decisionsTemplateList = [];
    if (request()->has('accused_status_ids') && count(request()->accused_status_ids) > 0) {
      $accusedStatusList = AccusedStatus::select('id', 'name as title', 'template')->whereIn('id', request()->accused_status_ids)->get();

      foreach ($accusedStatusList as $accusedStatus) {
        array_push($decisionsTemplateList, $accusedStatus);
      }
    }
    if (request()->has('decision_ids') && count(request()->decision_ids) > 0) {
      $decisionsList = Decision::whereIn('id', request()->decision_ids)->get();

      foreach ($decisionsList as $decision) {
        array_push($decisionsTemplateList, $decision);
      }
    }
    return response()->json([
      'template' => $decisionsTemplateList
    ]);
  }
  private function getAddress(Party $party)
  {
    $address = '';
    if ($party->destination) {
      $address .= 'م/ ' . $party->destination->name . '، ';
    }
    if ($party->part) {
      $address .= 'ق/ ' . $party->part . '، ';
    }
    if ($party->street) {
      $address .= 'ش/ ' . $party->street . '، ';
    }
    if ($party->avenue) {
      $address .= 'ج/ ' . $party->avenue . '، ';
    }
    if ($party->section) {
      $address .= 'قسيمة/ ' . $party->section . '، ';
    }
    if ($party->building) {
      $address .= 'مبنى/ ' . $party->building . '، ';
    }
    if ($party->floor) {
      $address .= 'دور/' . $party->floor . '. ';
    }
    if ($party->apartment) {
      $address .= 'شقة/' . $party->apartment . '، ';
    }
    return $address;
  }
  public function delete()
  {
    $investigation = Investigation::find(request()->investigation_id);
    IssueProsecutorLog::create([
      'issue_prosecutor_id' => $investigation->issue_prosecutor_id,
      'action_by_id' => Auth::id(),
      'action_to_id' => null,
      'ref_id' => null,

      'current_action' => config()->get('constants.actions.delete_investigation'),
      'created_at' => Carbon::now()
    ]);
    $investigation->delete();
    event(new InvestigationClosedEvent(request()->investigation_id));
  }
}
